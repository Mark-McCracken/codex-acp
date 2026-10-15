import {describe, expect, it} from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import {LoadSessionReplay, tagLoadSessionReplay, withLoadSessionReplayMarks} from "../LoadSessionReplay";

const UPDATE = acp.methods.client.session.update;

function wire() {
    const sent: Array<{method: string; params: any}> = [];
    const client = withLoadSessionReplayMarks({
        notify: async (method: string, params?: unknown) => {
            sent.push({method, params});
        },
        request: async () => undefined,
    });
    return {sent, client};
}

function update(sessionId: string, text: string, extra: Record<string, unknown> = {}) {
    return {sessionId, update: {sessionUpdate: "agent_message_chunk", content: {type: "text", text}}, ...extra};
}

describe("LoadSessionReplay", () => {
    it("keeps the notification _meta keys and adds the replay position", async () => {
        const {sent, client} = wire();
        const replay = new LoadSessionReplay("s");

        await client.notify(UPDATE, tagLoadSessionReplay(update("s", "a", {_meta: {traceId: "t-1"}}), replay));
        await client.notify(UPDATE, tagLoadSessionReplay(update("s", "b", {_meta: {traceId: "t-2"}}), replay));
        await replay.finish();

        expect(sent.map(({params}) => params._meta)).toEqual([
            {traceId: "t-1", loadSessionReplayIndex: 0},
            {traceId: "t-2", loadSessionReplayIndex: 1, loadSessionEndOfRecordedHistory: true},
        ]);
        expect(sent.every(({params}) => Object.getOwnPropertySymbols(params).length === 0)).toBe(true);
    });

    it("holds the latest update and sends a replayed update of another session after it, unmarked", async () => {
        const {sent, client} = wire();
        const replay = new LoadSessionReplay("s");

        await client.notify(UPDATE, tagLoadSessionReplay(update("s", "spawn"), replay));
        expect(sent).toEqual([]);
        await client.notify(UPDATE, tagLoadSessionReplay(update("child", "child output"), replay));
        await client.notify(UPDATE, tagLoadSessionReplay(update("s", "child ended"), replay));
        await replay.finish();

        expect(sent.map(({params}) => [params.sessionId, params.update.content.text, params._meta])).toEqual([
            ["s", "spawn", {loadSessionReplayIndex: 0}],
            ["child", "child output", undefined],
            ["s", "child ended", {loadSessionReplayIndex: 1, loadSessionEndOfRecordedHistory: true}],
        ]);
    });

    it("sends the held update without the end flag when the replay is abandoned", async () => {
        const {sent, client} = wire();
        const replay = new LoadSessionReplay("s");

        await client.notify(UPDATE, tagLoadSessionReplay(update("s", "a"), replay));
        await replay.abandon();

        expect(sent.map(({params}) => params._meta)).toEqual([{loadSessionReplayIndex: 0}]);
    });

    it("marks nothing when the replay sent nothing, and passes later or untagged updates as they are", async () => {
        const {sent, client} = wire();
        const replay = new LoadSessionReplay("s");

        await client.notify(UPDATE, update("s", "live"));
        await replay.finish();
        await client.notify(UPDATE, tagLoadSessionReplay(update("s", "late"), replay));

        expect(sent.map(({params}) => [params.update.content.text, params._meta])).toEqual([
            ["live", undefined],
            ["late", undefined],
        ]);
    });
});
