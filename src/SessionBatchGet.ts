/** Conservative metadata reads over the supported Codex app-server API. */
import {ErrorCodes} from "vscode-jsonrpc/node";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import {isConnectionDeathError} from "./app-server-recovery/AppServerRecovery";
import {isAppServerUnavailableError} from "./app-server-recovery/AppServerExit";
import {isArchivedRolloutPath} from "./SessionIndexMutations";
import type {SessionIndexThread} from "./SessionIndex";

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
): Promise<SessionIndexThread[]> {
    const entries: SessionIndexThread[] = [];
    for (const sessionId of sessionIds) {
        try {
            const {thread} = await client.threadRead({threadId: sessionId, includeTurns: false});
            // UUID parsing can normalize the ID. Opaque ACP IDs must still match exactly.
            if (thread.id !== sessionId) continue;
            entries.push({thread, archived: thread.path !== null && isArchivedRolloutPath(thread.path, codexHome)});
        } catch (error) {
            if (client.connectionLoss.lost || storeReadFailed(error)) throw error;
            // Unreadable or absent records contribute no row.
        }
    }
    return entries;
}
