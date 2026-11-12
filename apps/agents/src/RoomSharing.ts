/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { MatrixClient } from "matrix-bot-sdk";
import type { Agent, AgentStore } from "./store.ts";
import { PiConversation } from "./pi.ts";
import type {
    RoomGrant,
    RoomControl,
    RoomTurn,
    SharedConversation,
    SharedMessage,
    SharingSync,
} from "./roomSharingTypes.ts";

interface RoomState {
    type: string;
    state_key: string;
    content: Record<string, unknown>;
}

type OpenConversation = (file: string, authorize: () => Promise<void>) => Promise<SharedConversation>;

/** Authorize exact room audiences and route text without opening the DM's transcript or artifact queue. */
export class RoomSharing {
    private readonly agent: Agent;
    private readonly bot: MatrixClient;
    private readonly botId: string;
    private readonly store: AgentStore;
    private readonly folder: string;
    private readonly open: OpenConversation;
    private readonly conversations = new Map<string, { grant: RoomGrant; value: Promise<SharedConversation> }>();
    private readonly aborted = new Set<string>();
    private readonly work = new Map<string, Promise<void>>();
    private closing = false;

    public constructor(
        agent: Agent,
        bot: MatrixClient,
        store: AgentStore,
        config: { serverName: string; stateDir: string; model: string },
        open?: OpenConversation,
    ) {
        this.agent = agent;
        this.bot = bot;
        this.botId = `@clawdia_${agent.id.replaceAll("-", "")}:${config.serverName}`;
        this.store = store;
        this.folder = path.join(config.stateDir, agent.id, "rooms");
        this.open =
            open ??
            ((file, authorize) =>
                PiConversation.open(file, agent.name, agent.description, config.model, undefined, authorize));
    }

    /** Call only from room.decrypted_event, synchronously before the SDK commits its sync token. */
    public receive(roomId: string, event: SharedMessage): void {
        if (
            this.closing ||
            event.content.msgtype !== "m.text" ||
            typeof event.content.body !== "string" ||
            event.content.body.length > 20_000 ||
            typeof event.event_id !== "string" ||
            event.sender === this.botId
        )
            return;
        if (
            roomId === this.agent.room_id &&
            event.sender === this.agent.owner &&
            event.content.body.startsWith("!clawdia")
        ) {
            const command = this.parseControl(event.content.body);
            this.store.roomControl(this.agent.id, event.event_id, command.room, command.kind);
            this.abortInvalidConversations();
            return;
        }
        if (event.content.body.startsWith("!clawdia")) return;
        const grant = this.store.grant(this.agent.id, roomId);
        if (grant?.state === "checking") this.store.ignoreRoomEvents(this.agent.id, [event.event_id]);
        if (this.store.roomEventIgnored(this.agent.id, event.event_id)) return;
        if (!grant || grant.state !== "active" || !event.content["m.mentions"]?.user_ids?.includes(this.botId)) return;
        const audience = JSON.parse(grant.audience_json) as string[];
        if (!audience.includes(event.sender)) return;
        this.store.admitRoom(grant, event.event_id, event.sender, event.content.body);
    }

    private parseControl(body: string): { kind: RoomControl["kind"]; room: string } {
        const match = /^!clawdia (compartilhar|revogar) (\S+)\s*$/.exec(body);
        if (!match) return { kind: "help", room: "" };
        let room = match[2];
        try {
            if (!room.startsWith("!")) {
                const link = new URL(room);
                if (link.origin !== "https://matrix.to") throw new Error("invalid_link");
                room = decodeURIComponent(link.hash.replace(/^#\//, "").split("?")[0]);
            }
        } catch {
            return { kind: "help", room: "" };
        }
        if (!/^![^\s/?#]{1,254}$/.test(room) || room === this.agent.room_id) return { kind: "help", room: "" };
        return { kind: match[1] === "compartilhar" ? "share" : "revoke", room };
    }

    /** Invalidate before admitting any message from a batch that changes the audience or loses timeline state. */
    public beforeSync(batch: SharingSync): void {
        for (const grant of this.store.grants(this.agent.id)) {
            if (grant.state !== "active") continue;
            const room = batch.rooms?.join?.[grant.room_id];
            const audience = JSON.parse(grant.audience_json) as string[];
            const events = [...(room?.state?.events ?? []), ...(room?.timeline?.events ?? [])];
            const changed = events.some((event) => {
                if (event.type === "m.room.member" && event.state_key) {
                    return event.content.membership === "join"
                        ? !audience.includes(event.state_key)
                        : audience.includes(event.state_key);
                }
                return ["m.room.join_rules", "m.room.encryption", "m.room.power_levels"].includes(event.type ?? "");
            });
            if (changed || room?.timeline?.limited || batch.rooms?.leave?.[grant.room_id])
                this.store.suspendRoom(grant);
        }
        this.abortInvalidConversations();
    }

    /** Discard initial join timelines, then persist their boundary before activating the room. */
    public afterSync(batch: SharingSync): void {
        for (const grant of this.store.grants(this.agent.id)) {
            if (grant.state === "checking" && (batch.rooms?.join?.[grant.room_id] || !grant.await_room)) {
                const history = batch.rooms?.join?.[grant.room_id]?.timeline?.events ?? [];
                this.store.ignoreRoomEvents(
                    this.agent.id,
                    history.map((event) => event.event_id),
                );
                this.store.roomSync(grant, batch.next_batch);
            }
        }
    }

    private current(grant: RoomGrant, state = "active"): boolean {
        const now = this.store.grant(this.agent.id, grant.room_id);
        return !this.closing && now?.revision === grant.revision && now.state === state;
    }

    private async privateAudience(): Promise<void> {
        const members = await this.bot.getJoinedRoomMembers(this.agent.room_id!);
        if (members.length !== 2 || !members.includes(this.agent.owner) || !members.includes(this.botId))
            throw new Error("private_audience_changed");
    }

    private async audience(roomId: string): Promise<string[]> {
        const state = (await this.bot.getRoomState(roomId)) as RoomState[];
        const content = (type: string): Record<string, unknown> =>
            state.find((event) => event.type === type && event.state_key === "")?.content ?? {};
        const members = state
            .filter((event) => event.type === "m.room.member" && event.content.membership === "join")
            .map((event) => event.state_key)
            .sort();
        const server = this.botId.slice(this.botId.indexOf(":"));
        const power = content("m.room.power_levels");
        const users = (power.users ?? {}) as Record<string, number>;
        const level = users[this.agent.owner] ?? power.users_default ?? 0;
        const invite = power.invite ?? 0;
        if (
            content("m.room.encryption").algorithm !== "m.megolm.v1.aes-sha2" ||
            content("m.room.join_rules").join_rule !== "invite" ||
            !members.includes(this.agent.owner) ||
            !members.includes(this.botId) ||
            members.some((id) => !id.startsWith("@") || !id.endsWith(server)) ||
            typeof level !== "number" ||
            typeof invite !== "number" ||
            !Number.isFinite(level) ||
            !Number.isFinite(invite) ||
            level < invite
        ) {
            throw new Error("room_policy_denied");
        }
        return members;
    }

    private async authorize(grant: RoomGrant): Promise<void> {
        if (!this.current(grant)) throw new Error("room_access_revoked");
        try {
            const audience = await this.audience(grant.room_id);
            if (JSON.stringify(audience) !== grant.audience_json) throw new Error("room_audience_changed");
        } catch {
            this.store.suspendRoom(grant);
            this.abortInvalidConversations();
            throw new Error("room_access_denied");
        }
        if (!this.current(grant)) throw new Error("room_access_revoked");
    }

    private abortInvalidConversations(): void {
        for (const [key, { grant, value }] of this.conversations) {
            if (!this.current(grant) && !this.aborted.has(key)) {
                this.aborted.add(key);
                void value
                    .then(async (conversation) => {
                        await conversation.abort();
                        await conversation.close();
                    })
                    .catch(() => undefined);
            }
        }
    }

    /** Independent work keys keep revocation out of the model's queue. */
    public async tick(): Promise<void> {
        if (this.closing) return;
        const jobs: [string, () => Promise<void>][] = this.store
            .controls(this.agent.id)
            .map((control) => ["control:" + control.event_id, () => this.processControl(control)]);
        for (const grant of this.store.grants(this.agent.id)) {
            if (grant.state === "active")
                jobs.push(["room:" + grant.room_id + ":" + grant.revision, () => this.processRoom(grant)]);
        }
        await Promise.all(
            jobs.map(([key, run]) => {
                let work = this.work.get(key);
                if (!work) {
                    work = run()
                        .catch(() => undefined)
                        .finally(() => this.work.delete(key));
                    this.work.set(key, work);
                }
                return work;
            }),
        );
    }

    private async processControl(control: RoomControl): Promise<void> {
        let reply = control.reply;
        if (reply === null) {
            if (control.kind === "help")
                reply = "Use !clawdia compartilhar <link da sala> ou !clawdia revogar <link da sala>.";
            else if (control.kind === "revoke")
                reply = `Acesso revogado à sala ${control.room_id}. Novos turnos e entregas pendentes estão bloqueados.`;
            else {
                let grant = this.store.grant(this.agent.id, control.room_id)!;
                if (grant.revision !== control.revision)
                    reply = "Pedido de compartilhamento substituído por uma decisão posterior.";
                else if (grant.state === "checking") {
                    await this.privateAudience();
                    if (!this.current(grant, "checking")) return;
                    try {
                        const joined = await this.bot.getJoinedRooms();
                        if (!this.current(grant, "checking")) return;
                        if (joined.includes(grant.room_id)) this.store.roomAlreadyJoined(grant);
                        else if ((await this.bot.joinRoom(grant.room_id)) !== grant.room_id)
                            throw new Error("room_mismatch");
                        if (!this.current(grant, "checking")) return;
                        const audience = await this.audience(grant.room_id);
                        await this.privateAudience();
                        grant = this.store.grant(this.agent.id, grant.room_id)!;
                        if (grant.revision !== control.revision || grant.state !== "checking" || !grant.sync_token)
                            return;
                        if (!this.store.activateRoom(grant, audience)) return;
                        reply = `Agente compartilhado com a sala ${grant.room_id}. Audiência: ${audience.filter((id) => id !== this.botId).join(", ")}. Mencione o agente para conversar. A sala recebe somente texto e tem contexto próprio.`;
                    } catch {
                        this.store.suspendRoom(grant);
                        reply =
                            "Compartilhamento suspenso: confirme sala privada criptografada, membros locais e permissão do dono para convidar. Envie um novo comando para autorizar novamente.";
                    }
                } else
                    reply =
                        grant.state === "active"
                            ? `Agente compartilhado com a sala ${grant.room_id}.`
                            : "O compartilhamento não está ativo. Envie um novo comando para autorizar novamente.";
            }
            this.store.controlReply(this.agent.id, control.event_id, reply);
        }
        await this.privateAudience();
        const encrypted = await this.bot.crypto.encryptRoomEvent(this.agent.room_id!, "m.room.message", {
            "msgtype": "m.text",
            "body": reply,
            "m.relates_to": { "m.in_reply_to": { event_id: control.event_id } },
        });
        await this.privateAudience();
        if (this.closing || !this.store.controlPending(this.agent.id, control.event_id)) return;
        await this.bot.doRequest(
            "PUT",
            this.sendPath(this.agent.room_id!, "control:" + control.event_id),
            null,
            encrypted,
            20_000,
        );
        this.store.controlDelivered(this.agent.id, control.event_id);
    }

    private sendPath(room: string, identity: string): string {
        const transaction = createHash("sha256").update(`${this.agent.id}:${room}:${identity}`).digest("hex");
        return `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.encrypted/${transaction}`;
    }

    private async conversation(grant: RoomGrant): Promise<SharedConversation> {
        const key = grant.room_id + ":" + grant.revision;
        let entry = this.conversations.get(key);
        if (!entry) {
            const file = path.join(
                this.folder,
                createHash("sha256").update(grant.room_id).digest("hex"),
                String(grant.revision),
                "pi.sqlite",
            );
            const value = (async () => {
                await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
                await this.authorize(grant);
                return this.open(file, () => this.authorize(grant));
            })();
            entry = { grant, value };
            this.conversations.set(key, entry);
            void value.catch(() => this.conversations.delete(key));
        }
        return entry.value;
    }

    private async processRoom(grant: RoomGrant): Promise<void> {
        for (const message of this.store.roomTurns(grant)) {
            await this.authorize(grant);
            let answer = message.answer;
            if (answer === null) {
                const conversation = await this.conversation(grant);
                await this.authorize(grant);
                try {
                    answer = await conversation.reply(
                        message.event_id,
                        `Solicitante Matrix: ${message.sender}\nMensagem na sala autorizada:\n${message.body}`,
                    );
                } catch (error) {
                    if (
                        !(error instanceof Error) ||
                        !["model_turn_failed", "model_answer_empty"].includes(error.message)
                    )
                        throw error;
                    // Persist terminal failures so replaying this event cannot block later room messages.
                    answer = "Agent response failed. Please send your message again to try another turn.";
                }
                if (!this.current(grant)) return;
                this.store.roomAnswer(message, answer);
            }
            await this.publish(grant, message, answer);
        }
    }

    private async publish(grant: RoomGrant, message: RoomTurn, answer: string): Promise<void> {
        const encrypted =
            message.encrypted_json ??
            JSON.stringify(
                await this.bot.crypto.encryptRoomEvent(grant.room_id, "m.room.message", {
                    "msgtype": "m.text",
                    "body": answer,
                    "m.relates_to": { "m.in_reply_to": { event_id: message.event_id } },
                }),
            );
        await this.authorize(grant);
        // One writer, no await between the durable fence and starting the PUT. Revocation marks in-flight sends uncertain.
        if (!this.store.roomSending(message, encrypted)) return;
        await this.bot.doRequest(
            "PUT",
            this.sendPath(grant.room_id, `${grant.revision}:${message.event_id}`),
            null,
            JSON.parse(encrypted),
            20_000,
        );
        this.store.roomDelivered(message);
    }

    public async close(): Promise<void> {
        this.closing = true;
        await Promise.all(
            [...this.conversations.values()].map(async ({ value }) => {
                const conversation = await value.catch(() => undefined);
                await conversation?.close();
            }),
        );
        await Promise.all(this.work.values());
    }
}
