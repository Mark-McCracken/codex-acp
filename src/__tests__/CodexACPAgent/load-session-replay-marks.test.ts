import {describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import {createCodexMockTestFixture, createTestModel, type CodexMockTestFixture} from "../acp-test-utils";

const SESSION_ID = "session-1";
const AIR_CLIENT = {_meta: {jetbrains: {air: {version: 1}}}};

type Notification = {sessionId: string; update: {sessionUpdate: string; [key: string]: unknown}; _meta?: Record<string, unknown>};

function message(id: string, phase: string | null = null) {
    return {turnId: "turn-1", item: {type: "agentMessage", id, text: id, phase, memoryCitation: null, delivery: null, questions: null}};
}

/** A fixture whose `thread/resume` answers a paginated thread, and whose `thread/items/list` answers `pages`. */
function setUpLoad(pages: Array<() => Promise<unknown>>, options: {name?: string | null} = {}): CodexMockTestFixture {
    const fixture = createCodexMockTestFixture();
    const client = fixture.getCodexAcpClient();
    const appServer = fixture.getCodexAppServerClient();
    client.readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});
    client.getAccount = vi.fn().mockResolvedValue({account: null, requiresOpenaiAuth: false});
    client.listSkills = vi.fn().mockResolvedValue({data: []});
    const model = createTestModel();
    appServer.listModels = vi.fn().mockResolvedValue({data: [model], nextCursor: null});
    appServer.threadGoalGet = vi.fn().mockResolvedValue({goal: null});
    appServer.threadResume = vi.fn().mockResolvedValue({
        thread: {id: SESSION_ID, historyMode: "paginated", turns: [], cwd: "/test/project", name: options.name ?? null, preview: ""},
        itemsBackwardsCursor: "item:last",
        model: model.id,
        modelProvider: "openai",
        cwd: "/test/project",
        approvalPolicy: "never",
        sandbox: {type: "dangerFullAccess"},
        reasoningEffort: model.defaultReasoningEffort,
    });
    const list = vi.fn();
    for (const page of pages) list.mockImplementationOnce(page);
    appServer.threadItemsList = list;
    return fixture;
}

/** The `session/update` notifications that reached the wire, in order. */
function notifications(fixture: CodexMockTestFixture): Notification[] {
    return fixture.getAcpConnectionEvents([])
        .filter(event => event.method === "sessionUpdate")
        .map(event => event.args[0] as Notification);
}

function replayMarks(sent: Notification[]): Array<[string, unknown]> {
    return sent.map(notification => [
        `${notification.update.sessionUpdate}${notification.update["messageId"] ? ` ${notification.update["messageId"]}` : ""}`,
        notification._meta,
    ]);
}

async function load(fixture: CodexMockTestFixture, clientCapabilities: acp.ClientCapabilities = AIR_CLIENT) {
    const agent = fixture.getCodexAcpAgent();
    await agent.initialize({protocolVersion: 1, clientCapabilities});
    return agent.loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []});
}

describe("CodexACPAgent - loadSession replay marks", () => {
    it("marks each replayed update of the loaded session in order, and only the last one as the end", async () => {
        const fixture = setUpLoad([
            async () => ({data: [message("m3")], nextCursor: null, backwardsCursor: null}),
            async () => ({data: [message("m1"), message("m2", "commentary")], nextCursor: "page-2", backwardsCursor: null}),
            async () => ({data: [message("m3", "final_answer")], nextCursor: null, backwardsCursor: null}),
        ], {name: "Saved title"});

        await load(fixture);

        expect(replayMarks(notifications(fixture))).toEqual([
            ["available_commands_update", undefined],
            ["session_info_update", undefined],
            ["session_info_update", {loadSessionReplayIndex: 0}],
            ["agent_message_chunk m1", {loadSessionReplayIndex: 1}],
            ["agent_message_chunk m2", {loadSessionReplayIndex: 2}],
            ["agent_message_chunk m3", {loadSessionReplayIndex: 3, loadSessionEndOfRecordedHistory: true}],
        ]);
        // The update keeps its own `_meta`.
        const phased = notifications(fixture)
            .filter(notification => notification.update.sessionUpdate === "agent_message_chunk" && notification.update["_meta"] !== undefined);
        expect(phased.map(notification => notification.update["messageId"])).toEqual(["m2", "m3"]);
    });

    it("sends no mark for an empty history", async () => {
        const fixture = setUpLoad([
            async () => ({data: [], nextCursor: null, backwardsCursor: null}),
        ]);

        await load(fixture);

        const sent = notifications(fixture);
        expect(sent.length).toBeGreaterThan(0);
        expect(sent.every(notification => notification._meta === undefined)).toBe(true);
    });

    it("sends no end mark when a history page fails", async () => {
        const fixture = setUpLoad([
            async () => ({data: [message("last")], nextCursor: null, backwardsCursor: null}),
            async () => ({data: [message("first"), message("second")], nextCursor: "page-2", backwardsCursor: null}),
            async () => {
                throw new Error("History unavailable");
            },
        ]);
        vi.spyOn(fixture.getCodexAcpClient(), "closeSession").mockResolvedValue(undefined as never);

        await expect(load(fixture)).rejects.toThrow("History unavailable");

        expect(replayMarks(notifications(fixture).filter(notification => notification._meta !== undefined))).toEqual([
            ["agent_message_chunk first", {loadSessionReplayIndex: 0}],
            ["agent_message_chunk second", {loadSessionReplayIndex: 1}],
        ]);
    });

    it("sends no end mark when the client closes the session during the load", async () => {
        let closed: Promise<unknown> = Promise.resolve();
        const fixture = setUpLoad([
            async () => ({data: [message("last")], nextCursor: null, backwardsCursor: null}),
            async () => ({data: [message("first")], nextCursor: "page-2", backwardsCursor: null}),
            async () => ({data: [message("second")], nextCursor: "page-3", backwardsCursor: null}),
            // The adapter reads this page while it sends the page before it.
            async () => {
                closed = fixture.getCodexAcpAgent().closeSession({sessionId: SESSION_ID});
                await closed;
                return {data: [message("last")], nextCursor: null, backwardsCursor: null};
            },
        ]);
        vi.spyOn(fixture.getCodexAcpClient(), "closeSession").mockResolvedValue(undefined as never);

        await expect(load(fixture)).rejects.toMatchObject({code: -32600});
        await closed;

        const marked = notifications(fixture).filter(notification => notification._meta !== undefined);
        expect(marked.map(notification => notification._meta)).toEqual([{loadSessionReplayIndex: 0}]);
    });

    it("runs a second load of the session after the first one answers, and marks each replay on its own", async () => {
        let answerFirstReplay: () => void = () => {};
        const fixture = setUpLoad([
            async () => ({data: [message("m2")], nextCursor: null, backwardsCursor: null}),
            () => new Promise(resolve => answerFirstReplay = () => resolve(
                {data: [message("m1"), message("m2")], nextCursor: null, backwardsCursor: null},
            )),
            async () => ({data: [message("m2")], nextCursor: null, backwardsCursor: null}),
            async () => ({data: [message("m1"), message("m2")], nextCursor: null, backwardsCursor: null}),
        ]);
        const appServer = fixture.getCodexAppServerClient();
        let resumesAtFirstAnswer = -1;
        const first = load(fixture).then(() => {
            resumesAtFirstAnswer = vi.mocked(appServer.threadResume).mock.calls.length;
        });
        await vi.waitFor(() => expect(appServer.threadItemsList).toHaveBeenCalledTimes(2));
        const second = fixture.getCodexAcpAgent().loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []});

        answerFirstReplay();
        await first;
        await second;

        expect(resumesAtFirstAnswer).toBe(1);
        expect(appServer.threadResume).toHaveBeenCalledTimes(2);
        expect(replayMarks(notifications(fixture).filter(notification => notification._meta !== undefined))).toEqual([
            ["agent_message_chunk m1", {loadSessionReplayIndex: 0}],
            ["agent_message_chunk m2", {loadSessionReplayIndex: 1, loadSessionEndOfRecordedHistory: true}],
            ["agent_message_chunk m1", {loadSessionReplayIndex: 0}],
            ["agent_message_chunk m2", {loadSessionReplayIndex: 1, loadSessionEndOfRecordedHistory: true}],
        ]);
    });

    it("marks nothing for a client that is not AIR", async () => {
        const fixture = setUpLoad([
            async () => ({data: [message("m1")], nextCursor: null, backwardsCursor: null}),
            async () => ({data: [message("m1")], nextCursor: null, backwardsCursor: null}),
        ]);

        await load(fixture, {});

        const sent = notifications(fixture);
        expect(sent.some(notification => notification.update.sessionUpdate === "agent_message_chunk")).toBe(true);
        expect(sent.every(notification => notification._meta === undefined)).toBe(true);
    });

    it("leaves the updates that follow the load unmarked", async () => {
        const fixture = setUpLoad([
            async () => ({data: [message("m1")], nextCursor: null, backwardsCursor: null}),
            async () => ({data: [message("m1")], nextCursor: null, backwardsCursor: null}),
        ]);
        await load(fixture);
        fixture.clearAcpConnectionDump();

        fixture.sendServerNotification({
            method: "thread/name/updated",
            params: {threadId: SESSION_ID, threadName: "Renamed"},
        });

        await vi.waitFor(() => expect(notifications(fixture).length).toBeGreaterThan(0));
        expect(notifications(fixture).every(notification => notification._meta === undefined)).toBe(true);
    });
});
