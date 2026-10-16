import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel, type CodexMockTestFixture} from "../acp-test-utils";
import type {GetAccountResponse} from "../../app-server/v2";
import {AUTH_STATUS_UPDATE_METHOD} from "../../AuthStatusMeta";

const SESSION_ID = "session-1";
const SIGNED_IN: GetAccountResponse = {
    account: {type: "chatgpt", email: "user@example.com", planType: "plus"},
    requiresOpenaiAuth: true,
} as GetAccountResponse;

/** A fixture whose `thread/resume` answers a session with one history message. */
function loadFixture(): CodexMockTestFixture {
    const fixture = createCodexMockTestFixture();
    const client = fixture.getCodexAcpClient();
    const appServer = fixture.getCodexAppServerClient();
    client.listSkills = vi.fn().mockResolvedValue({data: []});
    const model = createTestModel();
    appServer.listModels = vi.fn().mockResolvedValue({data: [model], nextCursor: null});
    appServer.threadResume = vi.fn().mockResolvedValue({
        thread: {id: SESSION_ID, historyMode: "paginated", turns: [], cwd: "/test/project", name: null, preview: ""},
        itemsBackwardsCursor: "item:last",
        model: model.id,
        modelProvider: "openai",
        cwd: "/test/project",
        approvalPolicy: "never",
        sandbox: {type: "dangerFullAccess"},
        reasoningEffort: model.defaultReasoningEffort,
    });
    appServer.threadItemsList = vi.fn().mockResolvedValue({
        data: [{turnId: "turn-1", item: {type: "agentMessage", id: "m-1", text: "history", phase: null, memoryCitation: null, delivery: null, questions: null}}],
        nextCursor: null,
        backwardsCursor: null,
    });
    return fixture;
}

/** Initializes the agent and waits for the account read that `initialize` starts. */
async function initialize(fixture: CodexMockTestFixture): Promise<void> {
    await fixture.getCodexAcpAgent().initialize({protocolVersion: 1});
    for (let round = 0; round < 5; round += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    vi.mocked(fixture.getCodexAppServerClient().accountRead).mockClear();
}

describe("CodexACPAgent - loadSession auth", () => {
    it("resumes the thread while the account read runs, and reads the account once", async () => {
        const fixture = loadFixture();
        const appServer = fixture.getCodexAppServerClient();
        let answer: (response: GetAccountResponse) => void = () => {};
        appServer.accountRead = vi.fn()
            .mockResolvedValueOnce(SIGNED_IN)
            .mockImplementation(() => new Promise<GetAccountResponse>(resolve => answer = resolve));
        await initialize(fixture);

        const load = fixture.getCodexAcpAgent().loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []});
        await vi.waitFor(() => expect(appServer.threadResume).toHaveBeenCalledTimes(1));
        answer(SIGNED_IN);
        await load;

        expect(appServer.accountRead).toHaveBeenCalledTimes(1);
        expect(fixture.getCodexAcpAgent().getSessionState(SESSION_ID).account).toEqual(SIGNED_IN.account);
    });

    it("fails with auth_required and closes the resumed thread when the agent needs a login", async () => {
        const fixture = loadFixture();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        appServer.accountRead = vi.fn().mockResolvedValue({account: null, requiresOpenaiAuth: true});
        const closeSpy = vi.spyOn(client, "closeSession").mockResolvedValue(undefined as never);
        await initialize(fixture);

        await expect(fixture.getCodexAcpAgent().loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []}))
            .rejects.toMatchObject({code: -32000});

        expect(closeSpy).toHaveBeenCalledWith(SESSION_ID);
        expect(appServer.threadItemsList).not.toHaveBeenCalled();
        expect(() => fixture.getCodexAcpAgent().getSessionState(SESSION_ID)).toThrow();
    });

    it("fails with auth_required when the resume also fails", async () => {
        const fixture = loadFixture();
        const appServer = fixture.getCodexAppServerClient();
        appServer.accountRead = vi.fn().mockResolvedValue({account: null, requiresOpenaiAuth: true});
        appServer.threadResume = vi.fn().mockRejectedValue(new Error("no rollout found for thread id session-1"));
        await initialize(fixture);

        await expect(fixture.getCodexAcpAgent().loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []}))
            .rejects.toMatchObject({code: -32000});
    });

    it("streams the history before a slow account read ends, and answers with the account of the read", async () => {
        const fixture = loadFixture();
        const appServer = fixture.getCodexAppServerClient();
        let answer: (response: GetAccountResponse) => void = () => {};
        appServer.accountRead = vi.fn()
            .mockResolvedValueOnce(SIGNED_IN)
            .mockImplementation(() => new Promise<GetAccountResponse>(resolve => answer = resolve));
        await initialize(fixture);

        let answered = false;
        const load = fixture.getCodexAcpAgent().loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []})
            .finally(() => answered = true);
        await vi.waitFor(() => expect(historyText(fixture)).toEqual(["history"]));

        expect(answered).toBe(false);
        answer(SIGNED_IN);
        await load;
        expect(fixture.getCodexAcpAgent().getSessionState(SESSION_ID).account).toEqual(SIGNED_IN.account);
    });

    it("fails with auth_required and closes the session when the read finds no login after the history", async () => {
        const fixture = loadFixture();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        let answer: (response: GetAccountResponse) => void = () => {};
        appServer.accountRead = vi.fn()
            .mockResolvedValueOnce(SIGNED_IN)
            .mockImplementation(() => new Promise<GetAccountResponse>(resolve => answer = resolve));
        const closeSpy = vi.spyOn(client, "closeSession").mockResolvedValue(undefined as never);
        await initialize(fixture);

        const load = fixture.getCodexAcpAgent().loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []});
        await vi.waitFor(() => expect(historyText(fixture)).toEqual(["history"]));
        answer({account: null, requiresOpenaiAuth: true} as GetAccountResponse);

        await expect(load).rejects.toMatchObject({code: -32000});
        expect(closeSpy).toHaveBeenCalledWith(SESSION_ID);
        expect(() => fixture.getCodexAcpAgent().getSessionState(SESSION_ID)).toThrow();
    });

    it("sends no live turn event and no auth status when the read finds no login within the grace time", async () => {
        const fixture = loadFixture();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        let answer: (response: GetAccountResponse) => void = () => {};
        appServer.accountRead = vi.fn()
            .mockResolvedValueOnce(SIGNED_IN)
            .mockImplementation(() => new Promise<GetAccountResponse>(resolve => answer = resolve));
        vi.spyOn(client, "closeSession").mockResolvedValue(undefined as never);
        await initialize(fixture);
        fixture.clearAcpConnectionDump();

        const load = fixture.getCodexAcpAgent().loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []});
        await vi.waitFor(() => expect(historyText(fixture)).toEqual(["history"]));
        sendLiveDelta(fixture);
        await settle();
        answer({account: null, requiresOpenaiAuth: true} as GetAccountResponse);

        await expect(load).rejects.toMatchObject({code: -32000});
        await settle();
        expect(historyText(fixture)).toEqual(["history"]);
        expect(authStatusPushes(fixture)).toBe(0);
    });

    it("sends live turn events only after the account wait of the load", async () => {
        const fixture = loadFixture();
        const appServer = fixture.getCodexAppServerClient();
        let answer: (response: GetAccountResponse) => void = () => {};
        appServer.accountRead = vi.fn()
            .mockResolvedValueOnce(SIGNED_IN)
            .mockImplementation(() => new Promise<GetAccountResponse>(resolve => answer = resolve));
        await initialize(fixture);

        const load = fixture.getCodexAcpAgent().loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []});
        await vi.waitFor(() => expect(historyText(fixture)).toEqual(["history"]));
        sendLiveDelta(fixture);
        await settle();
        expect(historyText(fixture)).toEqual(["history"]);

        answer(SIGNED_IN);
        await load;
        await vi.waitFor(() => expect(historyText(fixture)).toEqual(["history", "live"]));
    });

    it("fails as closing and sends no live turn event when a close comes during the account wait", async () => {
        const fixture = loadFixture();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        let answer: (response: GetAccountResponse) => void = () => {};
        appServer.accountRead = vi.fn()
            .mockResolvedValueOnce(SIGNED_IN)
            .mockImplementation(() => new Promise<GetAccountResponse>(resolve => answer = resolve));
        vi.spyOn(client, "closeSession").mockResolvedValue(undefined as never);
        await initialize(fixture);
        const agent = fixture.getCodexAcpAgent();

        const load = agent.loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []});
        await vi.waitFor(() => expect(historyText(fixture)).toEqual(["history"]));
        const reconcile = vi.spyOn(agent.getSessionState(SESSION_ID).asyncTasks, "reconcile");
        sendLiveDelta(fixture);
        await settle();
        await agent.closeSession({sessionId: SESSION_ID});
        answer(SIGNED_IN);

        await expect(load).rejects.toMatchObject({code: -32600, data: `Session ${SESSION_ID} is closing`});
        await settle();
        expect(historyText(fixture)).toEqual(["history"]);
        expect(reconcile).not.toHaveBeenCalled();
    });

    it("runs a load that comes after a close only when the old load ended, and the old load does not close it", async () => {
        const fixture = loadFixture();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        let answer: (response: GetAccountResponse) => void = () => {};
        appServer.accountRead = vi.fn()
            .mockResolvedValueOnce(SIGNED_IN)
            .mockImplementationOnce(() => new Promise<GetAccountResponse>(resolve => answer = resolve))
            .mockResolvedValue(SIGNED_IN);
        const closeSpy = vi.spyOn(client, "closeSession").mockResolvedValue(undefined as never);
        await initialize(fixture);
        const agent = fixture.getCodexAcpAgent();

        const oldLoad = agent.loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []});
        await vi.waitFor(() => expect(historyText(fixture)).toEqual(["history"]));
        await agent.closeSession({sessionId: SESSION_ID});
        const newLoad = agent.loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []});
        await settle();
        expect(appServer.threadResume).toHaveBeenCalledTimes(1);
        answer({account: null, requiresOpenaiAuth: true} as GetAccountResponse);

        await expect(oldLoad).rejects.toMatchObject({code: -32600, data: `Session ${SESSION_ID} is closing`});
        await newLoad;
        expect(appServer.threadResume).toHaveBeenCalledTimes(2);
        expect(closeSpy).toHaveBeenCalledTimes(1);
        expect(historyText(fixture)).toEqual(["history", "history"]);
        expect(agent.getSessionState(SESSION_ID).account).toEqual(SIGNED_IN.account);
    });

    it("holds a prompt of the session until the load answers, and sends its permission request to the client", async () => {
        const fixture = loadFixture();
        const appServer = fixture.getCodexAppServerClient();
        let answer: (response: GetAccountResponse) => void = () => {};
        appServer.accountRead = vi.fn()
            .mockResolvedValueOnce(SIGNED_IN)
            .mockImplementationOnce(() => new Promise<GetAccountResponse>(resolve => answer = resolve))
            .mockResolvedValue(SIGNED_IN);
        await initialize(fixture);
        const agent = fixture.getCodexAcpAgent();
        const [turnCompleted, completeTurn] = deferred<unknown>();
        appServer.turnStart = vi.fn().mockResolvedValue({turn: {id: "turn-prompt", items: [], status: "inProgress", error: null}});
        appServer.awaitTurnCompleted = vi.fn().mockReturnValue(turnCompleted);

        const load = agent.loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []});
        await vi.waitFor(() => expect(historyText(fixture)).toEqual(["history"]));
        const prompt = agent.prompt({sessionId: SESSION_ID, prompt: [{type: "text", text: "Run the tests"}]});
        await settle();
        expect(appServer.turnStart).not.toHaveBeenCalled();

        answer(SIGNED_IN);
        await load;
        await vi.waitFor(() => expect(appServer.turnStart).toHaveBeenCalledTimes(1));
        fixture.setPermissionResponse({outcome: {outcome: "selected", optionId: "allow_once"}});
        await fixture.sendServerRequest("item/commandExecution/requestApproval", {
            threadId: SESSION_ID,
            turnId: "turn-prompt",
            itemId: "command-1",
            startedAtMs: 0,
            environmentId: null,
            command: "npm test",
            cwd: "/test/project",
        });
        expect(permissionRequests(fixture)).toBe(1);
        sendDelta(fixture, "turn-prompt", "prompt");
        await vi.waitFor(() => expect(historyText(fixture)).toEqual(["history", "prompt"]));

        completeTurn({threadId: SESSION_ID, turn: {id: "turn-prompt", items: [], status: "completed", error: null}});
        await prompt;
    });

    it("drops a v2 prompt that waits for the load on session/cancel, and starts no turn after the load", async () => {
        const {fixture, agent, answer, load} = await startHeldLoad();

        let failure: unknown = null;
        const prompt = agent.promptV2({sessionId: SESSION_ID, prompt: [{type: "text", text: "Run the tests"}]})
            .catch(error => failure = error);
        await settle();
        await agent.cancel({sessionId: SESSION_ID});
        await prompt;

        expect(failure).toMatchObject({code: -32800});
        answer(SIGNED_IN);
        await load;
        await settle();
        expect(fixture.getCodexAppServerClient().turnStart).not.toHaveBeenCalled();
    });

    it("drops a v2 prompt that waits for the load when the client cancels its request", async () => {
        const {fixture, agent, answer, load} = await startHeldLoad();

        const request = new AbortController();
        let failure: unknown = null;
        const prompt = agent.promptV2({sessionId: SESSION_ID, prompt: [{type: "text", text: "Run the tests"}]}, request.signal)
            .catch(error => failure = error);
        await settle();
        request.abort();
        await prompt;

        expect(failure).toMatchObject({code: -32800});
        answer(SIGNED_IN);
        await load;
        await settle();
        expect(fixture.getCodexAppServerClient().turnStart).not.toHaveBeenCalled();
    });

    it("answers cancelled to a v1 prompt that waits for the load on session/cancel, and starts no turn", async () => {
        const {fixture, agent, answer, load} = await startHeldLoad();

        const prompt = agent.prompt({sessionId: SESSION_ID, prompt: [{type: "text", text: "Run the tests"}]});
        await settle();
        await agent.cancel({sessionId: SESSION_ID});

        await expect(prompt).resolves.toMatchObject({stopReason: "cancelled"});
        answer(SIGNED_IN);
        await load;
        await settle();
        expect(fixture.getCodexAppServerClient().turnStart).not.toHaveBeenCalled();
    });

    it("drops a steer that waits for the load on session/cancel, and starts no turn after the load", async () => {
        const {fixture, agent, answer, load} = await startHeldLoad();
        const appServer = fixture.getCodexAppServerClient();

        let failure: unknown = null;
        const steer = agent.executeOrQueueSteeringRequest({sessionId: SESSION_ID, prompt: [{type: "text", text: "Stop"}]})
            .catch(error => failure = error);
        await settle();
        await agent.cancel({sessionId: SESSION_ID});
        await steer;

        expect(failure).toMatchObject({code: -32800});
        answer(SIGNED_IN);
        await load;
        await settle();
        expect(appServer.turnStart).not.toHaveBeenCalled();
        expect(appServer.turnSteer).not.toHaveBeenCalled();
    });

    it("drops a v2 prompt that starts to wait for the load during a close, and starts no turn after a reload", async () => {
        const {fixture, agent, answer, load} = await startHeldLoad();
        const appServer = fixture.getCodexAppServerClient();
        const [unsubscribed, unsubscribe] = deferred<void>();
        vi.spyOn(appServer, "threadUnsubscribe").mockImplementation(async () => {
            await unsubscribed;
            return {status: "unsubscribed"};
        });
        load.catch(() => {});

        const close = agent.closeSession({sessionId: SESSION_ID});
        await vi.waitFor(() => expect(appServer.threadUnsubscribe).toHaveBeenCalled());
        let failure: unknown = null;
        const prompt = agent.promptV2({sessionId: SESSION_ID, prompt: [{type: "text", text: "Run the tests"}]})
            .catch(error => failure = error);
        await settle();
        unsubscribe();
        await close;
        await prompt;

        expect(failure).toMatchObject({code: -32800});
        expect(waitingRequestCancellers(agent).size).toBe(0);
        answer(SIGNED_IN);
        await load.catch(() => {});
        await agent.loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []});
        await agent.cancel({sessionId: SESSION_ID});
        await settle();
        expect(appServer.turnStart).not.toHaveBeenCalled();
    });

    it("answers cancelled to a v1 prompt that starts to wait for the load during a close, and starts no turn after a reload", async () => {
        const {fixture, agent, answer, load} = await startHeldLoad();
        const appServer = fixture.getCodexAppServerClient();
        const [unsubscribed, unsubscribe] = deferred<void>();
        vi.spyOn(appServer, "threadUnsubscribe").mockImplementation(async () => {
            await unsubscribed;
            return {status: "unsubscribed"};
        });
        load.catch(() => {});

        const close = agent.closeSession({sessionId: SESSION_ID});
        await vi.waitFor(() => expect(appServer.threadUnsubscribe).toHaveBeenCalled());
        const prompt = agent.prompt({sessionId: SESSION_ID, prompt: [{type: "text", text: "Run the tests"}]});
        await settle();
        unsubscribe();
        await close;

        await expect(prompt).resolves.toMatchObject({stopReason: "cancelled"});
        expect(waitingRequestCancellers(agent).size).toBe(0);
        answer(SIGNED_IN);
        await load.catch(() => {});
        await agent.loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []});
        await agent.cancel({sessionId: SESSION_ID});
        await settle();
        expect(appServer.turnStart).not.toHaveBeenCalled();
    });

    it("keeps no canceller entry for a session after its waiting requests end", async () => {
        const {agent, answer, load} = await startHeldLoad();

        const request = new AbortController();
        const prompt = agent.promptV2({sessionId: SESSION_ID, prompt: [{type: "text", text: "Run the tests"}]}, request.signal)
            .catch(() => {});
        await settle();
        expect(waitingRequestCancellers(agent).has(SESSION_ID)).toBe(true);
        request.abort();
        await prompt;

        expect(waitingRequestCancellers(agent).size).toBe(0);
        answer(SIGNED_IN);
        await load;
    });

    it("loads two sessions at the same time", async () => {
        const fixture = loadFixture();
        const appServer = fixture.getCodexAppServerClient();
        // The responses of the fixture.
        const resumeResponse = await appServer.threadResume({} as never);
        const historyPage = await appServer.threadItemsList({} as never);
        appServer.threadResume = vi.fn().mockImplementation(async (params: {threadId: string}) => ({
            ...resumeResponse,
            thread: {...resumeResponse.thread, id: params.threadId},
        }));
        let holdHistory = true;
        const historyAnswers: Array<() => void> = [];
        appServer.threadItemsList = vi.fn().mockImplementation(() => holdHistory
            ? new Promise(resolve => historyAnswers.push(() => resolve(historyPage)))
            : Promise.resolve(historyPage));
        appServer.accountRead = vi.fn().mockResolvedValue(SIGNED_IN);
        await initialize(fixture);
        const agent = fixture.getCodexAcpAgent();

        const loads = ["session-1", "session-2"]
            .map(sessionId => agent.loadSession({sessionId, cwd: "/test/project", mcpServers: []}));
        // The history read of each load waits, so both loads run.
        await vi.waitFor(() => expect(appServer.threadResume).toHaveBeenCalledTimes(2));
        holdHistory = false;
        for (const answerHistory of historyAnswers) answerHistory();

        await Promise.all(loads);
        expect(agent.getSessionState("session-1").sessionId).toBe("session-1");
        expect(agent.getSessionState("session-2").sessionId).toBe("session-2");
    });
});

/** Starts a load whose account read waits for `answer`, and waits until its history arrived. */
async function startHeldLoad() {
    const fixture = loadFixture();
    const appServer = fixture.getCodexAppServerClient();
    let answer: (response: GetAccountResponse) => void = () => {};
    appServer.accountRead = vi.fn()
        .mockResolvedValueOnce(SIGNED_IN)
        .mockImplementationOnce(() => new Promise<GetAccountResponse>(resolve => answer = resolve))
        .mockResolvedValue(SIGNED_IN);
    appServer.turnStart = vi.fn().mockResolvedValue({turn: {id: "turn-prompt", items: [], status: "inProgress", error: null}});
    appServer.turnSteer = vi.fn();
    await initialize(fixture);
    const agent = fixture.getCodexAcpAgent();
    const load = agent.loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []});
    await vi.waitFor(() => expect(historyText(fixture)).toEqual(["history"]));
    return {fixture, agent, answer: (response: GetAccountResponse) => answer(response), load};
}

function deferred<T>(): [Promise<T>, (value: T) => void] {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(innerResolve => resolve = innerResolve);
    return [promise, resolve];
}

/** Sends a live agent message delta of the loaded session. */
function sendLiveDelta(fixture: CodexMockTestFixture): void {
    sendDelta(fixture, "turn-live", "live");
}

/** Sends an agent message delta of the session in the turn. */
function sendDelta(fixture: CodexMockTestFixture, turnId: string, delta: string): void {
    fixture.sendServerNotification({
        method: "item/agentMessage/delta",
        params: {threadId: SESSION_ID, turnId, itemId: `m-${turnId}`, delta},
    });
}

/** The number of permission requests that reached the client. */
function permissionRequests(fixture: CodexMockTestFixture): number {
    return fixture.getAcpConnectionEvents([]).filter(event => event.method === "requestPermission").length;
}

/** Lets the pending event handlers run. */
async function settle(): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

/** The number of auth status pushes that reached the client. */
function authStatusPushes(fixture: CodexMockTestFixture): number {
    return fixture.getAcpConnectionEvents([])
        .filter(event => event.method === "notify" && event.args[0] === AUTH_STATUS_UPDATE_METHOD)
        .length;
}

/** The text of the replayed agent messages that reached the client. */
function historyText(fixture: CodexMockTestFixture): string[] {
    return fixture.getAcpConnectionEvents([])
        .filter(event => event.method === "sessionUpdate")
        .map(event => event.args[0].update)
        .filter(update => update.sessionUpdate === "agent_message_chunk")
        .map(update => update.content.text);
}

/** The per-session cancellers of the requests that wait before their turn. */
function waitingRequestCancellers(agent: unknown): Map<string, Set<() => void>> {
    return (agent as {waitingRequestCancellers: Map<string, Set<() => void>>}).waitingRequestCancellers;
}
