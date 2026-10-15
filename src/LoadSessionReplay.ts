import * as acp from "@agentclientprotocol/sdk";

/** The 0-based position of a replayed notification in the replay, in the notification `_meta`. */
export const LOAD_SESSION_REPLAY_INDEX_KEY = "loadSessionReplayIndex";

/** `true` on the last replayed notification, in the notification `_meta`. */
export const LOAD_SESSION_END_OF_RECORDED_HISTORY_KEY = "loadSessionEndOfRecordedHistory";

const REPLAY = Symbol("loadSessionReplay");

type Params = Record<string | symbol, unknown> & {sessionId?: unknown; _meta?: unknown};
type Notify = (method: string, params: Params) => Promise<void>;

interface HeldNotification {
    method: string;
    params: Params;
    notify: Notify;
}

/**
 * Marks the `session/update` notifications that replay the history of one `session/load`, or of a v2
 * `session/resume` with `replayFrom: {type: "start"}`.
 *
 * Each replayed notification of the loaded session gets `loadSessionReplayIndex` in the notification `_meta`.
 * The last one also gets `loadSessionEndOfRecordedHistory: true`, so the client knows that the replay is
 * complete before the load answers. The history arrives in pages, so the replay holds back its latest
 * notification until the next one, or until {@link finish}.
 *
 * A replayed notification of another session, such as the history of a native subagent, is not marked.
 * It sends the held notification first, so the order on the wire does not change.
 * A notification without the replay tag, such as a live event, passes unmarked.
 */
export class LoadSessionReplay {
    private nextIndex = 0;
    private held: HeldNotification | null = null;
    private open = true;

    constructor(readonly sessionId: string) {}

    /** Sends the held notification without the end flag. Use it before a send that does not go through the replay. */
    async release(): Promise<void> {
        await this.sendHeld(false);
    }

    /** Sends the held notification with the end flag. Later notifications pass unmarked. */
    async finish(): Promise<void> {
        this.open = false;
        await this.sendHeld(true);
    }

    /** Sends the held notification without the end flag, for a replay that failed or was closed. */
    async abandon(): Promise<void> {
        this.open = false;
        await this.sendHeld(false);
    }

    /** @internal Called by {@link withLoadSessionReplayMarks} for a notification with this replay's tag. */
    async send(method: string, params: Params, notify: Notify): Promise<void> {
        if (!this.open) {
            await notify(method, params);
            return;
        }
        await this.sendHeld(false);
        if (params.sessionId !== this.sessionId) {
            await notify(method, params);
            return;
        }
        this.held = {method, params, notify};
    }

    private async sendHeld(end: boolean): Promise<void> {
        const held = this.held;
        if (held === null) return;
        this.held = null;
        const meta = isRecord(held.params._meta) ? held.params._meta : {};
        await held.notify(held.method, {
            ...held.params,
            _meta: {
                ...meta,
                [LOAD_SESSION_REPLAY_INDEX_KEY]: this.nextIndex++,
                ...(end ? {[LOAD_SESSION_END_OF_RECORDED_HISTORY_KEY]: true} : {}),
            },
        });
    }
}

/** Returns `params` tagged for `replay`, or `params` itself when there is no replay. */
export function tagLoadSessionReplay<T extends object>(params: T, replay: LoadSessionReplay | null | undefined): T {
    return replay ? {...params, [REPLAY]: replay} : params;
}

/** The replay tag of `params`, kept by an object spread. */
export function loadSessionReplayOf(params: unknown): LoadSessionReplay | null {
    if (!isRecord(params)) return null;
    const replay = (params as Params)[REPLAY];
    return replay instanceof LoadSessionReplay ? replay : null;
}

/**
 * Wraps the client connection that writes to the wire. A `session/update` with a replay tag goes through
 * its {@link LoadSessionReplay}, after every layer above has filtered and rendered it.
 */
export function withLoadSessionReplayMarks<C extends ClientConnection>(client: C): C {
    const connection: ClientConnection = {
        notify: async (method, params) => {
            const replay = method === acp.methods.client.session.update ? loadSessionReplayOf(params) : null;
            if (!replay) {
                await client.notify(method, params);
                return;
            }
            const untagged: Params = {...(params as Params)};
            delete untagged[REPLAY];
            await replay.send(method, untagged, (m, p) => client.notify(m, p));
        },
        request: (method, params, options) => client.request(method, params, options),
    };
    return connection as C;
}

type ClientConnection = {
    notify(method: string, params?: unknown): Promise<void>;
    request(method: string, params?: unknown, options?: acp.SendRequestOptions): Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
