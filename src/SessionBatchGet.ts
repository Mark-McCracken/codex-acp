/** Conservative metadata reads over the supported Codex app-server API. */
import {constants, promises as fs} from "node:fs";
import path from "node:path";
import {RequestError} from "@agentclientprotocol/sdk/unstable";
import {ErrorCodes} from "vscode-jsonrpc/node";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import {isConnectionDeathError} from "./app-server-recovery/AppServerRecovery";
import {isAppServerUnavailableError} from "./app-server-recovery/AppServerExit";
import {isArchivedRolloutPath} from "./SessionIndexMutations";
import type {SessionBatchGetResponse, SessionIndexThread} from "./SessionIndex";

/** Check roots without enumerating history. Missing roots are normal; inaccessible or dangling roots are not. */
async function checkStoreRoots(codexHome: string | null): Promise<void> {
    if (codexHome === null) throw RequestError.internalError("Codex session store location is unavailable");
    for (const root of [codexHome, path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")]) {
        try {
            await fs.lstat(root);
        } catch (error) {
            if (root !== codexHome && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
        }
        if (!(await fs.stat(root)).isDirectory()) throw RequestError.internalError("Codex session store root is not a directory");
        await fs.access(root, constants.R_OK | constants.X_OK);
    }
}

function rpcError(error: unknown): {code?: unknown; message?: unknown; data?: unknown} {
    return error !== null && typeof error === "object" ? error : {};
}

/** These are store discovery/DB failures, rather than a failure to decode one record. */
function storeReadFailed(error: unknown): boolean {
    const {code, message, data} = rpcError(error);
    if (isConnectionDeathError(error) || isAppServerUnavailableError(error)
        || code === ErrorCodes.MessageWriteError || code === ErrorCodes.MessageReadError
        || code === ErrorCodes.ConnectionInactive || code === ErrorCodes.ServerNotInitialized) return true;
    if (data !== null && typeof data === "object" && "reason" in data && data.reason === "serverShuttingDown") return true;
    if (typeof message !== "string") return false;
    return (code === -32603 && /^failed to read thread: thread-store internal error: failed to read thread metadata for [^:]+: /.test(message))
        || (code === -32600 && /^failed to locate (?:archived )?thread id [^:]+: /.test(message));
}

export async function readSessionBatchMetadata(
    client: CodexAppServerClient,
    codexHome: string | null,
    sessionIds: string[],
): Promise<{entries: SessionIndexThread[]; missing: string[]; errors: SessionBatchGetResponse["errors"]}> {
    await checkStoreRoots(codexHome);
    const entries: SessionIndexThread[] = [];
    const missing: string[] = [];
    const errors: SessionBatchGetResponse["errors"] = [];
    for (const sessionId of sessionIds) {
        try {
            const {thread} = await client.threadRead({threadId: sessionId, includeTurns: false});
            // UUID parsing can normalize the ID. Opaque ACP IDs must still match exactly.
            if (thread.id !== sessionId) throw new Error("Codex returned a different session ID");
            entries.push({thread, archived: thread.path !== null && isArchivedRolloutPath(thread.path, codexHome)});
        } catch (error) {
            if (client.connectionLoss.lost || storeReadFailed(error)) throw error;
            const {code, message} = rpcError(error);
            // Only the native ID parser proves that no stored Codex thread can have this ID.
            // "no rollout found" also covers existing indexed records with inaccessible paths.
            if (code === -32600 && typeof message === "string" && message.startsWith("invalid thread id: ")) {
                missing.push(sessionId);
            } else {
                errors.push({sessionId, code: "unavailable", message: "Session metadata could not be read"});
            }
        }
    }
    return {entries, missing, errors};
}
