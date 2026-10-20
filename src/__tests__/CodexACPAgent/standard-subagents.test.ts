import {afterEach, describe, expect, it, vi} from "vitest";
import type {ClientCapabilities} from "@agentclientprotocol/sdk/unstable";
import type {ServerNotification} from "../../app-server";
import type {ThreadItem} from "../../app-server/v2";
import {SubagentAssociations} from "../../subagents/SubagentAssociations";
import {subagentProtocol} from "../../subagents/AcpSubagents";
import {AIR_NATIVE_SUBAGENT_SESSIONS_KEY, withAirMeta} from "../../AirExtension";
import {GOAL_CONTROL_METHOD, SESSION_STEERING_METHOD} from "../../AcpExtensions";
import {ASYNC_TASK_STOP_METHOD} from "../../async-tasks/AsyncTaskExtension";
import {SESSION_ARCHIVE_METHOD, SESSION_RENAME_METHOD, SESSION_UNARCHIVE_METHOD} from "../../SessionIndex";
import {
    agentMessageDelta, commandExecutionItem, connectSession, codexResponse, createThread, createTurn, cwd,
    itemStarted, sessionId, titleThreadId, turnCompleted, turnStarted, userMessageItem,
    type PromptSession,
} from "./v2-prompt-harness";
import {expectConformingV2SessionUpdates} from "./v2-session-update-guard";

const child = "worker";
const childId = `${sessionId}:subagent:${child}`;
const capabilities: ClientCapabilities = {subagents: {}};

function onThread(notification: ServerNotification, threadId: string): ServerNotification {
    return {...notification, params: {...notification.params, threadId}} as ServerNotification;
}

function activity(id = child, path = "/root/worker", kind: "started" | "completed" | "interacted" = "started"): ServerNotification {
    return itemStarted({type: "subAgentActivity", id: `activity-${id}-${kind}`, kind, agentThreadId: id, agentPath: path});
}

async function flush(harness: PromptSession): Promise<void> {
    await harness.waitForNotifications();
    // A response on the same stream is a barrier for previously queued outbound notifications.
    await harness.request("session/list", {});
}

function childUpdates(harness: PromptSession) {
    return harness.scopedUpdates.filter(entry =>
        entry.sessionId.includes(":subagent:") || entry.update.sessionUpdate === "subagent_update");
}

function hasText(update: PromptSession["scopedUpdates"][number]["update"], text: string): boolean {
    const content = "content" in update ? update.content : null;
    return update.sessionUpdate === "agent_message_chunk" && typeof content === "object" && content !== null
        && "type" in content && content.type === "text" && "text" in content && content.text === text;
}

function history(h: PromptSession, rootItems: ThreadItem[], childTurns: ThreadItem[][], onRead?: () => void | Promise<void>) {
    h.setCodexResponse("thread/resume", async params => {
        const id = (params as {threadId: string}).threadId;
        return {...codexResponse("thread/start") as object, thread: {...createThread(), id, sessionId: id}};
    });
    h.setCodexResponse("thread/read", async params => {
        const {threadId: id, includeTurns} = params as {threadId: string; includeTurns?: boolean};
        if (id === child && includeTurns) await onRead?.();
        const turns = id === child ? childTurns : [rootItems];
        return {thread: {...createThread(), id, sessionId: id, turns: turns.map((items, index) => ({
            ...createTurn("completed", `${id}-turn-${index}`), itemsView: "full", items,
        }))}};
    });
}

async function snapshot(harness: PromptSession, name: string) {
    await flush(harness);
    await expect(JSON.stringify(childUpdates(harness), null, 2)).toMatchFileSnapshot(`data/${name}.json`);
}

describe("standard subagent protocol selection", () => {
    it("selects one contract and retains AIR's opt-ins and fallback", () => {
        const air = {_meta: withAirMeta(undefined, "capabilities", [AIR_NATIVE_SUBAGENT_SESSIONS_KEY])};
        const airWithoutOptIn = {_meta: withAirMeta(undefined, "capabilities", [])};
        expect([
            subagentProtocol(null, 1), subagentProtocol(capabilities, 1),
            subagentProtocol(null, 2), subagentProtocol(air, 1), subagentProtocol(air, 2),
            subagentProtocol(airWithoutOptIn, 1), subagentProtocol(airWithoutOptIn, 2),
            subagentProtocol({...airWithoutOptIn, ...capabilities}, 1),
        ]).toEqual(["hidden", "standard", "standard", "air", "air", "hidden", "hidden", "air"]);
    });

    it("namespaces fork identities without ambiguous delimiters or cross-tree parents", () => {
        const registry = new SubagentAssociations();
        const first = registry.register("root", "root", child);
        const fork = registry.register("fork", "fork", child);
        expect(first.sessionId).not.toBe(fork.sessionId);
        expect(registry.sessionId("a", "b:subagent:c")).not.toBe(registry.sessionId("a:subagent:b", "c"));
        expect(() => registry.register("fork", first.sessionId, "nested")).toThrow();
        expect(() => registry.register("root", "another-parent", child)).toThrow();
        expect(registry.isRestricted(child)).toBe(true);
        expect(registry.nextToolCallId(first.sessionId, "mcp"))
            .not.toBe(registry.nextToolCallId(first.sessionId, "mcp"));
    });
});

describe.each([1, 2] as const)("ACP v%s standard child sessions", version => {
    let harness: PromptSession | undefined;
    afterEach(() => {
        harness?.connection.close();
        harness = undefined;
        expectConformingV2SessionUpdates();
    });

    async function connect(options: Parameters<typeof connectSession>[1] = {}) {
        harness = await connectSession(version, {v1ClientCapabilities: capabilities, ...options});
        return harness;
    }

    async function delegate(h: PromptSession) {
        const prompt = h.sendPrompt([{type: "text", text: "Delegate"}]);
        await vi.waitFor(() => expect(h.turnStartParams).toHaveLength(1));
        h.emit(turnStarted());
        const id = h.turnStartParams[0]!["clientUserMessageId"];
        h.emit(itemStarted(userMessageItem(typeof id === "string" ? id : null, "Delegate")));
        h.emit(activity());
        h.emit(onThread(turnStarted("child-first"), child));
        h.emit(turnCompleted());
        await prompt;
        await h.promptRunFinished();
    }

    it("announces once and keeps the same identity across idle and later work", async () => {
        const h = await connect();
        h.emit(activity());
        h.emit(onThread(turnStarted("child-first"), child));
        h.emit(onThread(agentMessageDelta("First result", "child-first", "child-message-1"), child));
        h.emit(onThread(turnCompleted("child-first"), child));
        await flush(h);
        h.emit(activity(child, "/root/worker", "interacted"));
        h.emit(onThread(turnStarted("child-second"), child));
        // A late ending of the first turn cannot finish the new one.
        h.emit(onThread(turnCompleted("child-first"), child));
        h.emit(onThread(agentMessageDelta("Second result", "child-second", "child-message-2"), child));
        h.emit(onThread(turnCompleted("child-second"), child));
        await snapshot(h, `standard-subagents-v${version}-identity`);
        const announcements = childUpdates(h).filter(({update}) => update.sessionUpdate === "subagent_update" && "capabilities" in update);
        expect(announcements).toHaveLength(1);
    });

    it("waits for truthful parentage and announces ancestors before buffered child traffic", async () => {
        const h = await connect();
        h.emit(activity("nested", "/root/coordinator/nested"));
        h.emit(onThread(turnStarted("nested-turn"), "nested"));
        h.emit(onThread(agentMessageDelta("Nested result", "nested-turn", "nested-message"), "nested"));
        await flush(h);
        expect(childUpdates(h)).toEqual([]);
        h.emit(activity("coordinator", "/root/coordinator"));
        await snapshot(h, `standard-subagents-v${version}-nested`);
    });

    it("rejects unadvertised mutations, including private extensions, and ignores direct cancellation", async () => {
        const h = await connect();
        h.emit(activity());
        h.emit(onThread(turnStarted("child-first"), child));
        await flush(h);
        const methods = [
            ["session/prompt", {prompt: [{type: "text", text: "Do not execute"}]}],
            ["session/resume", {cwd, mcpServers: []}],
            ["session/fork", {cwd, mcpServers: []}],
            ["session/close", {}], ["session/delete", {}],
            ["session/set_config_option", {configId: "model", value: "gpt-5", ...(version === 2 ? {type: "id"} : {})}],
            [SESSION_STEERING_METHOD, {prompt: [{type: "text", text: "Do not execute"}]}],
            [GOAL_CONTROL_METHOD, {action: "set", objective: "Do not execute"}],
            [ASYNC_TASK_STOP_METHOD, {asyncTaskId: "task"}],
            [SESSION_RENAME_METHOD, {title: "Do not execute"}],
            [SESSION_ARCHIVE_METHOD, {}], [SESSION_UNARCHIVE_METHOD, {}],
        ] as const;
        const errors = [];
        for (const [method, params] of methods) {
            try {
                await h.request(method, {sessionId: childId, ...params});
                throw new Error(`Unexpectedly accepted ${method}`);
            } catch (error) {
                errors.push({method, code: (error as {code?: number}).code});
            }
        }
        expect(errors).toEqual(methods.map(([method]) => ({method, code: -32600})));
        // A leaked provider id must not offer a second route around the child guard.
        await expect(h.request("session/close", {sessionId: child})).rejects.toMatchObject({code: -32600});
        await h.agent.cancel({sessionId: childId});
        expect(h.turnInterruptCalls()).toEqual([]);
        await expect(JSON.stringify(errors, null, 2)).toMatchFileSnapshot(`data/standard-subagents-v${version}-guards.json`);
    });

    it.each([false, true])("routes independent child permissions and withdraws obsolete replies (parent replay: %s)", async replay => {
        let answer!: () => void;
        let withdrawn = false;
        const h = await connect({
            onRequestPermission: (request, signal) => new Promise(resolve => {
                signal.addEventListener("abort", () => { withdrawn = true; }, {once: true});
                answer = () => resolve({outcome: {outcome: "selected", optionId: request.options[0]!.optionId}});
            }),
        });
        await delegate(h);
        h.emit(onThread(itemStarted(commandExecutionItem("child-command"), "child-first"), child));
        const permission = h.triggerApproval("item/commandExecution/requestApproval", {
            threadId: child, turnId: "child-first", itemId: "child-command",
            command: "echo hello", cwd, commandActions: [], reason: null,
            availableDecisions: ["accept", "decline"],
        });
        await vi.waitFor(() => expect(h.transcript.some(entry => "permissionRequest" in entry && entry.permissionRequest.sessionId === childId)).toBe(true));
        if (replay) {
            // Replay waits for title generation too; finish that unrelated mocked turn.
            await vi.waitFor(() => expect(h.appServer["pendingTurnCompletionResolvers"].get(titleThreadId)?.has("title-turn")).toBe(true));
            h.emit(onThread(turnCompleted("title-turn"), titleThreadId));
            history(h, [{type: "subAgentActivity", id: "started", kind: "started", agentThreadId: child, agentPath: "/root/worker"}],
                [[commandExecutionItem("child-command")]]);
            await h.request(version === 1 ? "session/load" : "session/resume", {
                sessionId, cwd, mcpServers: [], ...(version === 2 ? {replayFrom: {type: "start"}} : {}),
            });
            expect(withdrawn).toBe(false);
        }
        h.emit(onThread(turnCompleted("child-first"), child));
        await vi.waitFor(() => expect(withdrawn).toBe(true));
        await flush(h);
        // A late answer cannot revive the ended child turn.
        answer();
        expect(await permission).toMatchObject({decision: "cancel"});
        await snapshot(h, `standard-subagents-v${version}-permission${replay ? "-replay" : ""}`);
    });

    it("rejects obsolete approval replies even while terminal output is backpressured", async () => {
        let answer!: () => void;
        const h = await connect({
            onRequestPermission: request => new Promise(resolve => {
                answer = () => resolve({outcome: {outcome: "selected", optionId: request.options[0]!.optionId}});
            }),
        });
        await delegate(h);
        const approval = h.triggerApproval("item/commandExecution/requestApproval", {
            threadId: child, turnId: "child-first", itemId: "child-command",
            command: "echo hello", cwd, commandActions: [], reason: null, availableDecisions: ["accept", "decline"],
        });
        await vi.waitFor(() => expect(h.transcript.some(entry => "permissionRequest" in entry)).toBe(true));
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        h.agent["codexAcpClient"]["enqueueSessionNotification"](sessionId, () => held);
        try {
            h.emit(onThread(turnCompleted("child-first"), child));
            answer();
            expect(await approval).toEqual({decision: "cancel"});
        } finally {
            release();
        }
        await flush(h);
    });

    it("routes form elicitation to the child without reviving work when the answer arrives", async () => {
        const h = await connect({
            v1ClientCapabilities: {...capabilities, elicitation: {form: {}}},
            clientCapabilities: {elicitation: {form: {}}},
            onElicitation: async () => ({action: "decline"}),
        });
        await delegate(h);
        const response = await h.triggerApproval("item/tool/requestUserInput", {
            threadId: child, turnId: "child-first", itemId: "child-question", autoResolutionMs: null,
            questions: [{id: "question", header: "Question", question: "Choose", isOther: false, isSecret: false,
                options: [{label: "A", description: "Pick A"}]}],
        });
        expect(response).toEqual({answers: {}});
        expect(h.transcript.some(entry => "elicitationRequest" in entry
            && "sessionId" in entry.elicitationRequest && entry.elicitationRequest.sessionId === childId)).toBe(true);
        h.emit(onThread(turnCompleted("child-first"), child));
        await snapshot(h, `standard-subagents-v${version}-elicitation`);
    });

    it("keeps child plans and titles out of the parent's conversation", async () => {
        const h = await connect();
        h.emit(activity());
        h.emit(onThread(turnStarted("child-first"), child));
        h.emit({method: "thread/name/updated", params: {threadId: child, threadName: "Worker title"}});
        h.emit(onThread({method: "item/plan/delta", params: {
            threadId: child, turnId: "child-first", itemId: "child-plan", delta: "A child plan",
        }}, child));
        h.emit({method: "item/completed", params: {
            threadId: child, turnId: "child-first", completedAtMs: 0, item: {type: "plan", id: "child-plan", text: "A child plan"},
        }});
        h.emit(onThread(turnCompleted("child-first"), child));
        await snapshot(h, `standard-subagents-v${version}-plan-title`);
    });

    it("withdraws independent child permissions when the parent is cancelled", async () => {
        let withdrawn = false;
        const h = await connect({
            onRequestPermission: (_request, signal) => new Promise(resolve => {
                signal.addEventListener("abort", () => {
                    withdrawn = true;
                    resolve({outcome: {outcome: "cancelled"}});
                }, {once: true});
            }),
        });
        await delegate(h);
        const approval = h.triggerApproval("item/commandExecution/requestApproval", {
            threadId: child, turnId: "child-first", itemId: "child-command",
            command: "echo hello", cwd, commandActions: [], reason: null, availableDecisions: ["accept", "decline"],
        });
        await vi.waitFor(() => expect(h.transcript.some(entry => "permissionRequest" in entry)).toBe(true));
        await h.cancel();
        await vi.waitFor(() => expect(withdrawn).toBe(true));
        expect(await approval).toEqual({decision: "cancel"});
        expect(h.turnInterruptCalls()).toContainEqual({threadId: child, turnId: "child-first"});
    });

    it("ignores late child traffic from a disconnected runtime", async () => {
        const h = await connect();
        h.emit(activity());
        h.emit(onThread(turnStarted("child-first"), child));
        h.emit(onThread(itemStarted(commandExecutionItem("old-command"), "child-first"), child));
        await flush(h);
        await h.agent["sessions"].get(sessionId)!.subagents.finishOutstanding("disconnected");
        h.emit(onThread(turnStarted("stale-turn"), child));
        h.emit(onThread(agentMessageDelta("Stale output", "stale-turn", "stale-message"), child));
        h.emit(onThread(turnCompleted("child-first"), child));
        await snapshot(h, `standard-subagents-v${version}-disconnected`);
        expect(childUpdates(h).some(({update}) => hasText(update, "Stale output"))).toBe(false);
    });

    it("cascades parent cancellation without declaring an unobserved child outcome", async () => {
        const h = await connect();
        h.emit(activity());
        h.emit(onThread(turnStarted("child-first"), child));
        await flush(h);
        await h.cancel();
        await vi.waitFor(() => expect(h.turnInterruptCalls()).toContainEqual({threadId: child, turnId: "child-first"}));
        await flush(h);
        expect(childUpdates(h).filter(({update}) => update.sessionUpdate === "subagent_update" && "state" in update)).toHaveLength(1);
        h.emit(onThread({method: "turn/completed", params: {threadId: child, turn: createTurn("interrupted", "child-first")}}, child));
        await snapshot(h, `standard-subagents-v${version}-cancel`);
    });

    it("uses unknown on lost observability, not a fabricated failure or permanent closing", async () => {
        const h = await connect();
        h.emit(activity());
        h.emit(onThread(turnStarted("child-first"), child));
        h.emit({method: "thread/status/changed", params: {threadId: child, status: {type: "notLoaded"}}});
        await snapshot(h, `standard-subagents-v${version}-unknown`);
    });

    it("replays stable child identities and leaves historical work unconfirmed", async () => {
        const h = await connect();
        const rootItems: ThreadItem[] = [
            {type: "subAgentActivity", id: "started", kind: "started", agentThreadId: child, agentPath: "/root/worker"},
            {type: "subAgentActivity", id: "completed", kind: "completed", agentThreadId: child, agentPath: "/root/worker"},
        ];
        const reply: ThreadItem = {type: "agentMessage", id: "persisted-reply", text: "Historical result", phase: null,
            memoryCitation: null, delivery: null, questions: null};
        history(h, rootItems, [[userMessageItem(null, "Delegated task"), reply], [{...reply, id: "second-reply", text: "Historical follow-up"}]]);
        await h.request(version === 1 ? "session/load" : "session/resume", {
            sessionId, cwd, mcpServers: [], ...(version === 2 ? {replayFrom: {type: "start"}} : {}),
        });
        await snapshot(h, `standard-subagents-v${version}-replay`);
        expect(childUpdates(h).some(({update}) => update.sessionUpdate === "subagent_update" && "state" in update)).toBe(false);
    });

    it("deduplicates replay overlap and publishes only the latest live work snapshot after the response", async () => {
        const h = await connect();
        const rootItems: ThreadItem[] = [{type: "subAgentActivity", id: "started", kind: "started", agentThreadId: child, agentPath: "/root/worker"}];
        const reply: ThreadItem = {type: "agentMessage", id: "persisted-reply", text: "Historical result", phase: null,
            memoryCitation: null, delivery: null, questions: null};
        history(h, rootItems, [[reply]], () => {
            h.emit(activity());
            h.emit(onThread(turnStarted("child-overlap"), child));
            h.emit(onThread(agentMessageDelta("Historical result", "child-overlap", reply.id), child));
            h.emit(onThread(agentMessageDelta("New result", "child-overlap", "live-reply"), child));
            h.emit(onThread(turnCompleted("child-overlap"), child));
        });
        await h.request(version === 1 ? "session/load" : "session/resume", {
            sessionId, cwd, mcpServers: [], ...(version === 2 ? {replayFrom: {type: "start"}} : {}),
        });
        const boundary = childUpdates(h).length;
        await vi.waitFor(() => expect(childUpdates(h).some(({update}) =>
            hasText(update, "New result"))).toBe(true));
        await flush(h);
        const entries = childUpdates(h);
        expect(entries.filter(({update}) => hasText(update, "Historical result"))).toHaveLength(1);
        await expect(JSON.stringify([
            ...entries.slice(0, boundary), {response: "replay complete"}, ...entries.slice(boundary),
        ], null, 2)).toMatchFileSnapshot(`data/standard-subagents-v${version}-replay-live.json`);
    });

    it("remaps copied child identities when a fork's history is loaded", async () => {
        const h = await connect();
        const rootItems: ThreadItem[] = [{type: "subAgentActivity", id: "started", kind: "started", agentThreadId: child, agentPath: "/root/worker"}];
        history(h, rootItems, [[]]);
        h.setCodexResponse("thread/fork", async () => ({
            ...codexResponse("thread/start") as object, thread: {...createThread(), id: "fork", sessionId: "fork", forkedFromId: sessionId},
        }));
        const load = (id: string) => h.request(version === 1 ? "session/load" : "session/resume", {
            sessionId: id, cwd, mcpServers: [], ...(version === 2 ? {replayFrom: {type: "start"}} : {}),
        });
        await load(sessionId);
        const fork = await h.request("session/fork", {sessionId, cwd, mcpServers: []});
        await load(fork.sessionId);
        await snapshot(h, `standard-subagents-v${version}-fork`);
        const roster = childUpdates(h).filter(({update}) => update.sessionUpdate === "subagent_update");
        expect(roster.map(({sessionId}) => sessionId)).toEqual([sessionId, "fork"]);
    });

    it("serializes same-parent replay through the preceding response and live-traffic boundary", async () => {
        const h = await connect();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let reads = 0;
        let firstResponded = false;
        history(h, [{type: "subAgentActivity", id: "started", kind: "started", agentThreadId: child, agentPath: "/root/worker"}], [[]], async () => {
            reads++;
            if (reads === 1) await held;
            else expect(firstResponded).toBe(true);
        });
        const params = {sessionId, cwd, mcpServers: [], ...(version === 2 ? {replayFrom: {type: "start"}} : {})};
        const method = version === 1 ? "session/load" : "session/resume";
        const first = h.request(method, params).then(() => { firstResponded = true; });
        await vi.waitFor(() => expect(reads).toBe(1));
        const second = h.request(method, params);
        await h.request("session/list", {});
        expect(reads).toBe(1);
        h.emit(activity());
        h.emit(onThread(turnStarted("child-overlap"), child));
        h.emit(onThread(agentMessageDelta("Live result", "child-overlap", "overlap-message"), child));
        h.emit(onThread(turnCompleted("child-overlap"), child));
        release();
        await first;
        await second;
        await flush(h);
        expect(reads).toBe(2);
        expect(childUpdates(h).filter(({update}) => hasText(update, "Live result"))).toHaveLength(1);
    });

    it("does not let a queued setup reopen a parent closed while replay was in flight", async () => {
        const h = await connect();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let reads = 0;
        history(h, [{type: "subAgentActivity", id: "started", kind: "started", agentThreadId: child, agentPath: "/root/worker"}], [[]], async () => {
            reads++;
            await held;
        });
        const params = {sessionId, cwd, mcpServers: [], ...(version === 2 ? {replayFrom: {type: "start"}} : {})};
        const method = version === 1 ? "session/load" : "session/resume";
        const first = h.request(method, params);
        first.catch(() => {});
        await vi.waitFor(() => expect(reads).toBe(1));
        const second = h.request(method, params);
        second.catch(() => {});
        await h.request("session/list", {});
        await h.request("session/close", {sessionId});
        release();
        await expect(first).rejects.toMatchObject({code: -32600});
        await expect(second).rejects.toMatchObject({code: -32600});
        expect(reads).toBe(1);
    });
});
