/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import MatrixBotSdk, { MatrixClient, SimpleFsStorageProvider, RustSdkCryptoStorageProvider } from "matrix-bot-sdk";

const credentialPath = process.env.CLAWDIA_MATRIX_TEST_CREDENTIALS;
const realModel = process.env.CLAWDIA_REAL_MODEL_TEST === "1";

void test(
    `real Synapse encrypted DM and Pi SQLite survive a process restart (${realModel ? "real" : "faux"} model)`,
    { skip: !credentialPath, timeout: 120_000 },
    async () => {
        const credentials = JSON.parse(await readFile(credentialPath!, "utf8")) as {
            user_id: string;
            access_token: string;
            password: string;
        };
        const homeserver = process.env.CLAWDIA_MATRIX_TEST_URL ?? "http://127.0.0.1:18008";
        const folder = await mkdtemp(path.join(tmpdir(), "clawdia-matrix-"));
        const quiet = (): void => {};
        MatrixBotSdk.LogService.setLogger({ trace: quiet, debug: quiet, info: quiet, warn: quiet, error: quiet });
        const loginResponse = await fetch(`${homeserver}/_matrix/client/v3/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                type: "m.login.password",
                identifier: { type: "m.id.user", user: credentials.user_id },
                password: credentials.password,
                device_id: randomUUID(),
            }),
        });
        assert.equal(loginResponse.status, 200);
        const login = (await loginResponse.json()) as { access_token: string };
        const owner = new MatrixClient(
            homeserver,
            login.access_token,
            new SimpleFsStorageProvider(path.join(folder, "owner.json")),
            new RustSdkCryptoStorageProvider(
                path.join(folder, "owner-crypto"),
                0 /* StoreType.Sqlite is an erased const enum in the native SDK. */,
            ),
        );
        const listener = createServer();
        listener.listen(0, "127.0.0.1");
        await once(listener, "listening");
        const port = (listener.address() as { port: number }).port;
        await new Promise<void>((done) => listener.close(() => done()));
        const address = `http://127.0.0.1:${port}`;
        let worker: ChildProcess | undefined;
        const responses = new Map<string, string>();
        const onMessage = (
            _room: string,
            event: {
                sender: string;
                content: { "body": string; "m.relates_to"?: { "m.in_reply_to"?: { event_id: string } } };
            },
        ) => {
            const source = event.content["m.relates_to"]?.["m.in_reply_to"]?.event_id;
            if (source && event.sender !== credentials.user_id) responses.set(source, event.content.body);
        };
        owner.on("room.message", onMessage);
        const start = async (): Promise<void> => {
            worker = spawn(
                process.execPath,
                [
                    ...(realModel ? [] : ["--import", new URL("./fixtures/faux-model.ts", import.meta.url).pathname]),
                    new URL("./server.ts", import.meta.url).pathname,
                ],
                {
                    env: {
                        ...process.env,
                        NODE_ENV: "test",
                        PORT: String(port),
                        HOST: "127.0.0.1",
                        MATRIX_HOMESERVER: homeserver,
                        MATRIX_SERVER_NAME: credentials.user_id.split(":").slice(1).join(":"),
                        MATRIX_ADMIN_TOKEN: credentials.access_token,
                        CLAWDIA_ALLOWED_USERS: credentials.user_id,
                        CLAWDIA_STATE_DIR: path.join(folder, "agents"),
                        PI_PROVIDER: realModel ? process.env.PI_PROVIDER : "openai",
                        PI_MODEL: realModel ? process.env.PI_MODEL : "faux-1",
                        OPENAI_API_KEY: realModel
                            ? process.env.OPENAI_API_KEY
                            : "integration-test-placeholder-unused-by-faux",
                    },
                    stdio: ["ignore", "ignore", "pipe"],
                },
            );
            let diagnostics = "";
            worker.stderr?.on("data", (data: Buffer) => {
                diagnostics = (diagnostics + data.toString()).slice(-800);
            });
            for (let i = 0; i < 100; i++) {
                if (worker.exitCode !== null) throw new Error(`Worker exited before readiness: ${diagnostics}`);
                try {
                    if ((await fetch(`${address}/health`)).ok) return;
                } catch {
                    /* Waiting for bind. */
                }
                await sleep(100);
            }
            throw new Error("Worker readiness timeout");
        };
        const stop = async (): Promise<void> => {
            if (!worker || worker.exitCode !== null) return;
            const exited = once(worker, "exit");
            worker.kill("SIGTERM");
            await exited;
        };
        const reply = async (roomId: string, body: string, expected: string): Promise<void> => {
            const eventId = await owner.sendMessage(roomId, { msgtype: "m.text", body });
            for (let i = 0; i < 600; i++) {
                if (responses.has(eventId)) {
                    assert.equal(responses.get(eventId), expected);
                    return;
                }
                await sleep(100);
            }
            throw new Error("Encrypted Pi reply timeout");
        };
        try {
            await owner.start();
            await start();
            const key = randomUUID();
            const create = () =>
                fetch(`${address}/clawdia/agents`, {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${login.access_token}`,
                        "Content-Type": "application/json",
                        "Idempotency-Key": key,
                    },
                    body: JSON.stringify({ name: "Analista de teste", description: "Conversa de validação" }),
                });
            const response = await create();
            assert.equal(response.status, 200);
            const agent = (await response.json()) as { roomId: string; userId: string; status: string };
            assert.equal(agent.status, "ready");
            assert.deepEqual(await (await create()).json(), agent);
            await owner.joinRoom(agent.roomId);
            assert.equal(
                (await owner.getRoomStateEvent(agent.roomId, "m.room.encryption", "")).algorithm,
                "m.megolm.v1.aes-sha2",
            );
            const a = 1000 + Math.floor(Math.random() * 8000);
            const b = 1000 + Math.floor(Math.random() * 8000);
            const marker = `reinicio-${randomUUID().slice(0, 8)}`;
            await reply(
                agent.roomId,
                realModel
                    ? `Calcule ${a} + ${b}. Responda apenas ${marker}= seguido da soma. Guarde essa soma.`
                    : "Olá, Pi",
                realModel ? `${marker}=${a + b}` : "Pi respondeu pela DM criptografada.",
            );
            await stop();
            await start();
            assert.deepEqual(await (await create()).json(), agent);
            await reply(
                agent.roomId,
                realModel
                    ? "Some 7 à soma que você guardou antes. Responda apenas com o novo número."
                    : "Voltamos depois do reinício",
                realModel ? String(a + b + 7) : "Pi respondeu pela DM criptografada.",
            );
        } finally {
            await stop();
            owner.off("room.message", onMessage);
            owner.stop();
            await rm(folder, { recursive: true, force: true });
        }
    },
);
