/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { MatrixClient, SimpleFsStorageProvider, RustSdkCryptoStorageProvider } from "matrix-bot-sdk";
import type { AgentStore, Agent } from "./store.ts";
import { FirecrackerMachine } from "./FirecrackerMachine.ts";
import { PiConversation } from "./pi.ts";

/** Settings kept exclusively in the trusted service. */
export interface AgentConfig {
    homeserver: string;
    serverName: string;
    adminToken: string;
    stateDir: string;
    model: string;
}

/** Provision and run the private Matrix device and Pi conversation of each agent. */
export class AgentManager {
    private readonly running = new Map<string, Promise<MatrixClient>>();
    private readonly conversations = new Map<string, PiConversation>();
    private readonly draining = new Map<string, Promise<void>>();
    private closing = false;

    private readonly config: AgentConfig;
    public readonly store: AgentStore;
    private readonly retry: ReturnType<typeof setInterval>;

    public constructor(config: AgentConfig, store: AgentStore) {
        this.config = config;
        this.store = store;
        this.retry = setInterval(() => {
            for (const [id, work] of this.running) {
                void work.then((bot) => this.drain(this.store.get(id)!, bot)).catch(() => undefined);
            }
        }, 5000);
        this.retry.unref();
    }

    public async matrixRequest(
        path: string,
        token: string,
        method: "GET" | "POST" | "PUT",
        body?: unknown,
    ): Promise<unknown> {
        const options: RequestInit = {
            method,
            headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            signal: AbortSignal.timeout(20_000),
        };
        if (method !== "GET" && body !== undefined) options.body = JSON.stringify(body);
        const response = await fetch(`${this.config.homeserver}${path}`, options);
        if (!response.ok) throw new Error(`matrix_${response.status}`);
        return response.json();
    }

    public ensure(agent: Agent): Promise<MatrixClient> {
        const existing = this.running.get(agent.id);
        if (existing) return existing;
        const work = this.start(agent).catch((error: unknown) => {
            this.running.delete(agent.id);
            this.store.status(agent.id, "failed");
            throw error;
        });
        this.running.set(agent.id, work);
        return work;
    }

    private async start(agent: Agent): Promise<MatrixClient> {
        this.store.status(agent.id, "preparing");
        const localpart = `clawdia_${agent.id.replaceAll("-", "")}`;
        const botId = `@${localpart}:${this.config.serverName}`;
        const folder = path.join(this.config.stateDir, agent.id);
        await mkdir(folder, { recursive: true, mode: 0o700 });
        // A stable device and password make recovery of a partially provisioned user possible.
        if (!agent.bot_token) {
            await this.matrixRequest(
                `/_synapse/admin/v2/users/${encodeURIComponent(botId)}`,
                this.config.adminToken,
                "PUT",
                {
                    password: agent.password,
                    displayname: agent.name,
                    admin: false,
                },
            );
            const login = (await this.matrixRequest("/_matrix/client/v3/login", "", "POST", {
                type: "m.login.password",
                identifier: { type: "m.id.user", user: botId },
                password: agent.password,
                device_id: `CLAWDIA_${agent.id}`,
            })) as { access_token: string };
            this.store.token(agent.id, login.access_token);
            agent = this.store.get(agent.id)!;
        }
        const bot = new MatrixClient(
            this.config.homeserver,
            agent.bot_token!,
            new SimpleFsStorageProvider(path.join(folder, "matrix.json")),
            new RustSdkCryptoStorageProvider(
                path.join(folder, "crypto"),
                0 /* StoreType.Sqlite is an erased const enum in the native SDK. */,
            ),
        );
        try {
            if (!agent.room_id) {
                const alias = `#${localpart}:${this.config.serverName}`;
                let roomId: string;
                try {
                    roomId = await bot.resolveRoom(alias);
                } catch (error) {
                    if ((error as { errcode?: string }).errcode !== "M_NOT_FOUND") throw error;
                    roomId = await bot.createRoom({
                        room_alias_name: localpart,
                        name: agent.name,
                        preset: "private_chat",
                        visibility: "private",
                        invite: [agent.owner],
                        is_direct: true,
                        power_level_content_override: { invite: 100, kick: 100, ban: 100, state_default: 100 },
                        initial_state: [
                            {
                                type: "m.room.encryption",
                                state_key: "",
                                content: { algorithm: "m.megolm.v1.aes-sha2" },
                            },
                        ],
                    });
                }
                this.store.room(agent.id, roomId);
                agent = this.store.get(agent.id)!;
            }
            const machine = process.env.CLAWDIA_FIRECRACKER_SOCKET
                ? new FirecrackerMachine(process.env.CLAWDIA_FIRECRACKER_SOCKET, agent.id)
                : undefined;
            if (machine) await machine.ensure();
            const conversation = await PiConversation.open(
                path.join(folder, "pi.sqlite"),
                agent.name,
                agent.description,
                this.config.model,
                machine ? { machine, record: (id, file) => this.store.artifact(agent.id, id, file) } : undefined,
            );
            this.conversations.set(agent.id, conversation);
            // Admission is synchronous, so a persisted sync cursor cannot overtake the inbox insert.
            bot.on(
                "room.message",
                (
                    roomId: string,
                    event: { event_id: string; sender: string; content: { msgtype: string; body: string } },
                ) => {
                    if (
                        this.closing ||
                        roomId !== agent.room_id ||
                        event.sender !== agent.owner ||
                        event.content.msgtype !== "m.text"
                    )
                        return;
                    if (typeof event.content.body !== "string" || event.content.body.length > 20_000) return;
                    this.store.admit(agent, event.event_id, event.content.body);
                    void this.drain(agent, bot);
                },
            );
            await bot.start();
            this.store.status(agent.id, "ready");
            void this.drain(agent, bot);
            return bot;
        } catch (error) {
            bot.stop();
            await this.conversations.get(agent.id)?.close();
            this.conversations.delete(agent.id);
            throw error;
        }
    }

    private drain(agent: Agent, bot: MatrixClient): Promise<void> {
        if (this.closing) return Promise.resolve();
        const active = this.draining.get(agent.id);
        if (active) return active;
        const work = this.processMessages(agent, bot).finally(() => this.draining.delete(agent.id));
        this.draining.set(agent.id, work);
        return work;
    }

    private async processMessages(agent: Agent, bot: MatrixClient): Promise<void> {
        try {
            for (const message of this.store.pending(agent.id)) {
                if (this.closing) break;
                const members = await bot.getJoinedRoomMembers(agent.room_id!);
                if (
                    !members.includes(agent.owner) ||
                    members.some(
                        (member) =>
                            member !== agent.owner &&
                            member !== `@clawdia_${agent.id.replaceAll("-", "")}:${this.config.serverName}`,
                    )
                )
                    break;
                let answer = message.answer;
                if (answer === null) {
                    try {
                        answer = await this.conversations.get(agent.id)!.reply(message.event_id, message.body);
                    } catch (error) {
                        if (
                            !(error instanceof Error) ||
                            !["model_turn_failed", "model_answer_empty"].includes(error.message)
                        )
                            throw error;
                        answer = "Agent response failed. Please send your message again to try another turn.";
                    }
                }
                this.store.answer(message.event_id, answer);
                if (this.closing) break;
                const audience = await bot.getJoinedRoomMembers(agent.room_id!);
                if (!audience.includes(agent.owner) || audience.some((member) => !members.includes(member))) break;
                for (const artifact of this.store.pendingArtifacts(agent.id)) {
                    let media = artifact.media_json;
                    if (!media) {
                        const encryptedFile = await bot.crypto.encryptMedia(Buffer.from(artifact.content));
                        const url = await bot.uploadContent(encryptedFile.buffer, "application/octet-stream");
                        media = JSON.stringify({ ...encryptedFile.file, url });
                        this.store.artifactMedia(agent.id, artifact.id, media);
                    }
                    // Recheck the audience immediately before each artifact publication too.
                    const viewers = await bot.getJoinedRoomMembers(agent.room_id!);
                    if (!viewers.includes(agent.owner) || viewers.some((member) => !members.includes(member))) return;
                    const fileEvent = await bot.crypto.encryptRoomEvent(agent.room_id!, "m.room.message", {
                        "msgtype": "m.file",
                        "body": path.posix.basename(artifact.path),
                        "file": JSON.parse(media),
                        "info": { mimetype: "text/plain", size: Buffer.byteLength(artifact.content) },
                        "m.relates_to": { "m.in_reply_to": { event_id: message.event_id } },
                    });
                    const fileTxn = createHash("sha256").update(`${agent.id}:${artifact.id}`).digest("hex");
                    await bot.doRequest(
                        "PUT",
                        `/_matrix/client/v3/rooms/${encodeURIComponent(agent.room_id!)}/send/m.room.encrypted/${fileTxn}`,
                        null,
                        fileEvent,
                    );
                    this.store.artifactDelivered(agent.id, artifact.id);
                }
                const transaction = createHash("sha256").update(message.event_id).digest("hex");
                const encrypted = await bot.crypto.encryptRoomEvent(agent.room_id!, "m.room.message", {
                    "msgtype": "m.text",
                    "body": answer,
                    "m.relates_to": { "m.in_reply_to": { event_id: message.event_id } },
                });
                await bot.doRequest(
                    "PUT",
                    `/_matrix/client/v3/rooms/${encodeURIComponent(agent.room_id!)}/send/m.room.encrypted/${transaction}`,
                    null,
                    encrypted,
                );
                this.store.delivered(message.event_id);
            }
        } catch {
            // Keep the admitted event for a later retry without exposing message or provider errors in logs.
            console.error("Agent message remains pending", agent.id);
        }
    }

    public async close(): Promise<void> {
        this.closing = true;
        clearInterval(this.retry);
        for (const work of this.running.values()) {
            const bot = await work.catch(() => undefined);
            bot?.stop();
        }
        await Promise.all([...this.conversations.values()].map((conversation) => conversation.close()));
        await Promise.all(this.draining.values());
    }
}
