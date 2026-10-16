/**
 * Serializes the loads of each session, and lets other requests wait for them.
 *
 * A load is a v1 `session/load` or a v2 `session/resume` with `replayFrom: start`. While a load of a session
 * runs, a second load of that session starts only after the first one answered or failed. Another open and a
 * prompt of the session call {@link whenIdle} first, so they also wait for the load. The loads of different
 * sessions do not wait for each other. A close of the session does not wait for the lock. A cancel or a close
 * of the session drops a waiting request that can start a turn.
 */
export class SessionLoadLock {
    // The end of the last queued load of each session. It never rejects.
    private readonly tails = new Map<string, Promise<void>>();

    /** Runs the load after the earlier loads of the session. The lock is free again when the load settles. */
    async run<T>(sessionId: string, load: () => Promise<T>): Promise<T> {
        const previous = this.tails.get(sessionId);
        let release!: () => void;
        const tail = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.tails.set(sessionId, tail);
        try {
            if (previous !== undefined) await previous;
            return await load();
        } finally {
            release();
            if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
        }
    }

    /**
     * Returns a promise that settles when the session has no queued or running load, or `null` when it has none
     * now. A caller awaits it only when it is not `null`, so a request on an idle session keeps its timing.
     */
    whenIdle(sessionId: string): Promise<void> | null {
        const tail = this.tails.get(sessionId);
        if (tail === undefined) return null;
        return tail.then(() => this.whenIdle(sessionId) ?? undefined);
    }
}
