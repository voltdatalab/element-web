/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
import MatrixBotSdk from "matrix-bot-sdk";
import { AgentStore } from "./store.ts";
import { AgentManager } from "./matrix.ts";

/** Parse a bounded agent creation body without trusting owner identity from the browser. */
export async function readCreation(
    request: IncomingMessage,
): Promise<{ name: string; description: string; key: string }> {
    let bytes = 0;
    const parts: Buffer[] = [];
    for await (const part of request) {
        bytes += part.length;
        if (bytes > 8192) throw new Error("body_too_large");
        parts.push(Buffer.from(part));
    }
    const body = JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_request");
    const { name, description = "" } = body;
    const key = request.headers["idempotency-key"];
    if (
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 120 ||
        typeof description !== "string" ||
        description.length > 2000 ||
        typeof key !== "string" ||
        !/^[a-f0-9-]{36}$/.test(key)
    )
        throw new Error("invalid_request");
    return { name: name.trim(), description: description.trim(), key };
}

/** Serve authenticated, idempotent provisioning through the installation's Matrix identity. */
export function createAgentHttpServer(
    manager: Pick<AgentManager, "matrixRequest" | "ensure" | "store">,
    allowed: ReadonlySet<string>,
    serverName: string,
): ReturnType<typeof createServer> {
    const store = manager.store;
    const send = (response: ServerResponse, status: number, body: unknown): void => {
        response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify(body));
    };
    return createServer(async (request, response) => {
        if (request.url === "/health" && request.method === "GET") return send(response, 200, { status: "ready" });
        if (request.url !== "/clawdia/agents" || request.method !== "POST")
            return send(response, 404, { error: "not_found" });
        const authorization = request.headers.authorization;
        if (!authorization?.startsWith("Bearer ")) return send(response, 401, { error: "unauthorized" });
        // The homeserver is installation configuration, never supplied by the caller.
        let owner: string;
        try {
            const identity = (await manager.matrixRequest(
                "/_matrix/client/v3/account/whoami",
                authorization.slice(7),
                "GET",
            )) as { user_id: string; is_guest?: boolean };
            owner = identity.user_id;
            if (!allowed.has(owner) || identity.is_guest) return send(response, 403, { error: "forbidden" });
        } catch {
            return send(response, 401, { error: "unauthorized" });
        }
        try {
            const creation = await readCreation(request);
            const agent = store.create(owner, creation.key, creation.name, creation.description);
            await manager.ensure(agent);
            const ready = store.get(agent.id)!;
            return send(response, 200, {
                id: ready.id,
                status: ready.status,
                roomId: ready.room_id,
                userId: `@clawdia_${ready.id.replaceAll("-", "")}:${serverName}`,
            });
        } catch (error) {
            const code =
                error instanceof SyntaxError
                    ? "invalid_request"
                    : error instanceof Error
                      ? error.message
                      : "provisioning_failed";
            const status =
                code === "request_conflict" ? 409 : ["invalid_request", "body_too_large"].includes(code) ? 400 : 503;
            return send(response, status, { error: status === 503 ? "provisioning_failed" : code });
        }
    });
}

/** Start the service with one writer for its state and Pi stores. */
export async function main(): Promise<void> {
    process.umask(0o077);
    const quiet = (): void => {};
    MatrixBotSdk.LogService.setLogger({
        trace: quiet,
        debug: quiet,
        info: quiet,
        warn: quiet,
        error: () => console.error("Matrix client operation failed"),
    });
    const homeserver = process.env.MATRIX_HOMESERVER?.replace(/\/$/, "");
    const serverName = process.env.MATRIX_SERVER_NAME;
    const adminToken = process.env.MATRIX_ADMIN_TOKEN;
    const model = process.env.PI_MODEL;
    const allowed = new Set((process.env.CLAWDIA_ALLOWED_USERS ?? "").split(",").filter(Boolean));
    if (!homeserver || !serverName || !adminToken || !model || !process.env.OPENAI_API_KEY || !allowed.size)
        throw new Error("service_not_configured");
    const stateDir = path.resolve(process.env.CLAWDIA_STATE_DIR ?? "./state");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
    const release = await lock(stateDir, {
        realpath: true,
        lockfilePath: path.join(stateDir, "writer.lock"),
        stale: 10_000,
    });
    const store = new AgentStore(path.join(stateDir, "agents.sqlite"));
    const manager = new AgentManager({ homeserver, serverName, adminToken, model, stateDir }, store);
    const server = createAgentHttpServer(manager, allowed, serverName);
    server.requestTimeout = 30_000;
    server.listen(Number(process.env.PORT ?? 8787), process.env.HOST ?? "127.0.0.1");
    for (const agent of store.all())
        void manager.ensure(agent).catch(() => console.error("Agent recovery failed", agent.id));
    const stop = async (): Promise<void> => {
        server.close();
        await manager.close();
        store.close();
        await release();
        // The Matrix SDK retains sync sockets after stop, so exit after durable cleanup.
        // oxlint-disable-next-line unicorn/no-process-exit
        process.exit(0);
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
    main().catch((error: unknown) => {
        const candidate = (error as { code?: unknown })?.code;
        const code =
            typeof candidate === "string" && /^[A-Z0-9_]{1,40}$/.test(candidate)
                ? candidate
                : "configuration_or_runtime";
        console.error("Agent service startup failed", code);
        process.exitCode = 1;
    });
}
