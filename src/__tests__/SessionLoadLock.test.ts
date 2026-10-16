import {describe, expect, it} from "vitest";
import {SessionLoadLock} from "../SessionLoadLock";

function deferred(): [Promise<void>, () => void, (error: Error) => void] {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });
    return [promise, resolve, reject];
}

async function settle(): Promise<void> {
    for (let round = 0; round < 5; round += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

describe("SessionLoadLock", () => {
    it("runs a second load of a session after the first one settles", async () => {
        const lock = new SessionLoadLock();
        const order: string[] = [];
        const [firstDone, endFirst] = deferred();

        const first = lock.run("s", async () => {
            order.push("first start");
            await firstDone;
            order.push("first end");
        });
        const second = lock.run("s", async () => {
            order.push("second");
        });
        await settle();
        expect(order).toEqual(["first start"]);

        endFirst();
        await Promise.all([first, second]);
        expect(order).toEqual(["first start", "first end", "second"]);
    });

    it("frees the lock when a load fails", async () => {
        const lock = new SessionLoadLock();
        const [firstDone, , failFirst] = deferred();

        const first = lock.run("s", () => firstDone);
        const second = lock.run("s", async () => "second");
        failFirst(new Error("load failed"));

        await expect(first).rejects.toThrow("load failed");
        await expect(second).resolves.toBe("second");
        expect(lock.whenIdle("s")).toBeNull();
    });

    it("does not hold back a load of another session", async () => {
        const lock = new SessionLoadLock();
        const [firstDone, endFirst] = deferred();

        const first = lock.run("s1", () => firstDone);
        await expect(lock.run("s2", async () => "other")).resolves.toBe("other");
        expect(lock.whenIdle("s2")).toBeNull();

        endFirst();
        await first;
    });

    it("lets a waiter go only when no load of the session is queued or running", async () => {
        const lock = new SessionLoadLock();
        const [firstDone, endFirst] = deferred();
        const [secondDone, endSecond] = deferred();
        expect(lock.whenIdle("s")).toBeNull();

        void lock.run("s", () => firstDone);
        let idle = false;
        void lock.whenIdle("s")!.then(() => idle = true);
        void lock.run("s", () => secondDone);
        endFirst();
        await settle();
        expect(idle).toBe(false);

        endSecond();
        await settle();
        expect(idle).toBe(true);
        expect(lock.whenIdle("s")).toBeNull();
    });
});
