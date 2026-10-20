import * as acp from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {appendFileSync, mkdirSync, mkdtempSync} from "node:fs";
import {join} from "node:path";
import {Readable, Writable} from "node:stream";
import {expect, it, vi} from "vitest";
import {removeDirectoryWithRetry, writeCodexHomeConfig} from "../acp-test-utils";
import {describeIntegration, INTEGRATION_MODEL_ID} from "./integration-fixture";
import {functionCallResponse, startMockResponsesServer, textResponse} from "./mock-responses-server";

describeIntegration("integration: standard subagent sessions", () => {
    it.each([1, 2] as const)("announces and routes real Codex children through ACP v%s", async version => {
        const mock = await startMockResponsesServer();
        let delegated = false;
        mock.setResponseHandler(request => {
            const model = (request as {model?: string}).model;
            if (model === INTEGRATION_MODEL_ID.model && !delegated) {
                delegated = true;
                return functionCallResponse("delegate-once", "spawn_agent", {
                    message: "Reply with CHILD_RESULT", task_name: "worker", fork_turns: "none",
                }, "collaboration");
            }
            return textResponse("CHILD_RESULT");
        });
        const temporaryRoot = join(process.cwd(), "node_modules", ".cache", "codex-acp-tests");
        mkdirSync(temporaryRoot, {recursive: true});
        const root = mkdtempSync(join(temporaryRoot, "standard-subagents-"));
        const cwd = join(root, "workspace");
        const codexHome = join(root, "codex-home");
        mkdirSync(cwd);
        mkdirSync(codexHome);
        writeCodexHomeConfig(codexHome, {
            model: INTEGRATION_MODEL_ID.model,
            model_reasoning_effort: INTEGRATION_MODEL_ID.effort,
            web_search: "disabled",
            model_provider: "integration",
            "model_providers.integration.name": "Local integration mock",
            "model_providers.integration.base_url": mock.baseUrl,
            "model_providers.integration.wire_api": "responses",
        });
        appendFileSync(join(codexHome, "config.toml"), "\nfeatures.multi_agent = true\nfeatures.multi_agent_v2 = true\n");
        const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
            cwd: process.cwd(), env: {...process.env, CODEX_HOME: codexHome}, stdio: ["pipe", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", chunk => { stderr += chunk.toString(); });
        const updates: Array<{sessionId: string; update: any}> = [];
        const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
        const connection = version === 1
            ? acp.client().onNotification(acp.methods.client.session.update, ctx => { updates.push(ctx.params); }).connect(stream)
            : acpV2.client().onNotification(acpV2.methods.client.session.update, ctx => { updates.push(ctx.params); }).connect(stream);
        const context = connection.agent as {
            request(method: string, params: unknown, options: {cancellationSignal: AbortSignal}): Promise<any>;
        };
        const request = async (method: string, params: unknown) => {
            try {
                return await context.request(method, params, {cancellationSignal: AbortSignal.timeout(15_000)});
            } catch (error) {
                if (error instanceof Error) error.message = `${method}: ${error.message}\n${stderr}`;
                throw error;
            }
        };
        try {
            await request("initialize", version === 1 ? {
                protocolVersion: 1, clientCapabilities: {subagents: {}, auth: {_meta: {gateway: true}}},
            } : {
                protocolVersion: 2, info: {name: "subagent-integration", version: "1"},
                capabilities: {auth: {_meta: {gateway: true}}},
            });
            await request(version === 1 ? "authenticate" : "auth/login", {
                methodId: "gateway", _meta: {gateway: {baseUrl: mock.baseUrl, headers: {}}},
            });
            const {sessionId} = await request("session/new", {cwd, mcpServers: []});
            const prompt = request("session/prompt", {sessionId, prompt: [{type: "text", text: "Delegate once"}]});
            prompt.catch(() => {});
            await vi.waitFor(() => {
                const child = updates.find(entry => entry.sessionId === sessionId && entry.update.sessionUpdate === "subagent_update");
                const requests = mock.requests.map(request => {
                    const body = request as {model?: string; tools?: Array<{name?: string; type?: string}>; input?: Array<{type?: string}>};
                    return {model: body.model, tools: body.tools?.map(tool => tool.name ?? tool.type),
                        outputs: body.input?.filter(item => item.type === "function_call_output")};
                });
                expect(child, `${stderr}\n${JSON.stringify({updates, requests})}`).toBeDefined();
                const id = child!.update.sessionId;
                const announcement = updates.indexOf(child!);
                const message = updates.findIndex(entry => entry.sessionId === id
                    && entry.update.sessionUpdate === "agent_message_chunk" && entry.update.content.text.includes("CHILD_RESULT"));
                expect(message, `${stderr}\n${JSON.stringify(updates)}`).toBeGreaterThan(announcement);
                expect(updates.some(entry => entry.update.sessionUpdate === "subagent_update"
                    && entry.update.sessionId === id && entry.update.state?.state === "idle")).toBe(true);
            }, {timeout: 15_000});
            await prompt;
            expect(updates.some(entry => ["subagent_spawned", "subagent_state_update", "_subagent_update"].includes(entry.update.sessionUpdate))).toBe(false);
            expect(mock.unexpectedRequests).toBe(0);
        } finally {
            connection.close();
            child.kill("SIGTERM");
            if (child.exitCode === null) await once(child, "exit");
            await mock.close();
            await removeDirectoryWithRetry(root);
        }
    });
});
