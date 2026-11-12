/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { MachineArtifact } from "./MachineArtifact.ts";
import type { RoomGrant, RoomTurn, RoomControl } from "./roomSharingTypes.ts";

/** Persisted provisioning operation. Secrets are confined to the private service state directory. */
export interface Agent {
    id: string;
    owner: string;
    request_key: string;
    name: string;
    description: string;
    status: "preparing" | "ready" | "failed";
    password: string;
    bot_token: string | null;
    room_id: string | null;
}

/** Durable agent registration and admission queue, owned by one service process. */
export class AgentStore {
    public readonly database: DatabaseSync;

    public constructor(path: string) {
        this.database = new DatabaseSync(path);
        this.database.exec(`
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS agents (
                id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_key TEXT NOT NULL,
                name TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
                password TEXT NOT NULL, bot_token TEXT, room_id TEXT,
                UNIQUE(owner, request_key)
            );
            CREATE TABLE IF NOT EXISTS artifacts (
                id TEXT NOT NULL, agent_id TEXT NOT NULL, path TEXT NOT NULL,
                content TEXT NOT NULL, sha256 TEXT NOT NULL, media_json TEXT,
                delivered INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(agent_id,id)
            );
            CREATE TABLE IF NOT EXISTS messages (
                event_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, body TEXT NOT NULL,
                answer TEXT, delivered INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS room_grants (
                agent_id TEXT NOT NULL, room_id TEXT NOT NULL, revision INTEGER NOT NULL,
                state TEXT NOT NULL, audience_json TEXT NOT NULL, sync_token TEXT, await_room INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY(agent_id, room_id)
            );
            CREATE TABLE IF NOT EXISTS room_controls (
                agent_id TEXT NOT NULL, event_id TEXT NOT NULL, room_id TEXT NOT NULL,
                revision INTEGER NOT NULL, kind TEXT NOT NULL, reply TEXT, delivered INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(agent_id, event_id)
            );
            CREATE TABLE IF NOT EXISTS room_ignored_events (
                agent_id TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(agent_id,event_id)
            );
            CREATE TABLE IF NOT EXISTS room_turns (
                agent_id TEXT NOT NULL, event_id TEXT NOT NULL, room_id TEXT NOT NULL,
                revision INTEGER NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL, answer TEXT,
                state TEXT NOT NULL DEFAULT 'pending', encrypted_json TEXT, PRIMARY KEY(agent_id, event_id)
            );
        `);
    }

    public create(owner: string, key: string, name: string, description: string): Agent {
        const existing = this.database
            .prepare("SELECT * FROM agents WHERE owner = ? AND request_key = ?")
            .get(owner, key) as unknown as Agent | undefined;
        if (existing) {
            if (existing.name !== name || existing.description !== description) {
                throw new Error("request_conflict");
            }
            return existing;
        }
        const id = randomUUID();
        this.database
            .prepare("INSERT INTO agents VALUES (?, ?, ?, ?, ?, 'preparing', ?, NULL, NULL)")
            .run(id, owner, key, name, description, randomUUID());
        return this.get(id)!;
    }

    public get(id: string): Agent | undefined {
        return this.database.prepare("SELECT * FROM agents WHERE id = ?").get(id) as unknown as Agent | undefined;
    }

    public all(): Agent[] {
        return this.database.prepare("SELECT * FROM agents").all() as unknown as Agent[];
    }

    public token(id: string, token: string): void {
        this.database.prepare("UPDATE agents SET bot_token = ?, password = '' WHERE id = ?").run(token, id);
    }

    public room(id: string, roomId: string): void {
        this.database.prepare("UPDATE agents SET room_id = ? WHERE id = ?").run(roomId, id);
    }

    public status(id: string, status: Agent["status"]): void {
        this.database.prepare("UPDATE agents SET status = ? WHERE id = ?").run(status, id);
    }

    public admit(agent: Agent, eventId: string, body: string): void {
        this.database
            .prepare("INSERT OR IGNORE INTO messages (event_id, agent_id, body) VALUES (?, ?, ?)")
            .run(eventId, agent.id, body);
    }

    public pending(agentId: string): { event_id: string; body: string; answer: string | null }[] {
        return this.database
            .prepare("SELECT event_id, body, answer FROM messages WHERE agent_id = ? AND delivered = 0 ORDER BY rowid")
            .all(agentId) as unknown as { event_id: string; body: string; answer: string | null }[];
    }

    public answer(eventId: string, answer: string): void {
        this.database.prepare("UPDATE messages SET answer = ? WHERE event_id = ?").run(answer, eventId);
    }

    public artifact(agentId: string, id: string, file: MachineArtifact): void {
        const old = this.database
            .prepare("SELECT sha256,path FROM artifacts WHERE agent_id=? AND id=?")
            .get(agentId, id);
        if (old && (old.sha256 !== file.sha256 || old.path !== file.path)) throw new Error("artifact_conflict");
        this.database
            .prepare("INSERT OR IGNORE INTO artifacts (id,agent_id,path,content,sha256) VALUES (?,?,?,?,?)")
            .run(id, agentId, file.path, file.content, file.sha256);
    }

    public pendingArtifacts(agentId: string): (MachineArtifact & { id: string; media_json: string | null })[] {
        return this.database
            .prepare(
                "SELECT id,path,content,sha256,media_json FROM artifacts WHERE agent_id=? AND delivered=0 ORDER BY rowid",
            )
            .all(agentId) as unknown as (MachineArtifact & { id: string; media_json: string | null })[];
    }

    public artifactMedia(agentId: string, id: string, media: string): void {
        this.database.prepare("UPDATE artifacts SET media_json=? WHERE agent_id=? AND id=?").run(media, agentId, id);
    }

    public artifactDelivered(agentId: string, id: string): void {
        this.database.prepare("UPDATE artifacts SET delivered=1,content='' WHERE agent_id=? AND id=?").run(agentId, id);
    }

    public delivered(eventId: string): void {
        this.database.prepare("UPDATE messages SET delivered = 1 WHERE event_id = ?").run(eventId);
    }

    /** Owner control admission atomically fences old turns before any asynchronous work. */
    public roomControl(agentId: string, eventId: string, roomId: string, kind: RoomControl["kind"]): void {
        this.database.exec("BEGIN IMMEDIATE");
        try {
            const existing = this.database
                .prepare("SELECT 1 FROM room_controls WHERE agent_id=? AND event_id=?")
                .get(agentId, eventId);
            if (!existing) {
                let revision = 0;
                if (kind !== "help") {
                    revision = (this.grant(agentId, roomId)?.revision ?? 0) + 1;
                    this.blockRoom(agentId, roomId);
                    this.database
                        .prepare("UPDATE room_controls SET delivered=-1 WHERE agent_id=? AND room_id=? AND delivered=0")
                        .run(agentId, roomId);
                    this.database
                        .prepare(`INSERT INTO room_grants VALUES (?,?,?,?,?,NULL,1)
                        ON CONFLICT(agent_id,room_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,
                        audience_json='[]',sync_token=NULL,await_room=1`)
                        .run(agentId, roomId, revision, kind === "share" ? "checking" : "revoked", "[]");
                }
                this.database
                    .prepare("INSERT INTO room_controls (agent_id,event_id,room_id,revision,kind) VALUES (?,?,?,?,?)")
                    .run(agentId, eventId, roomId, revision, kind);
            }
            this.database.exec("COMMIT");
        } catch (error) {
            this.database.exec("ROLLBACK");
            throw error;
        }
    }

    public grant(agentId: string, roomId: string): RoomGrant | undefined {
        return this.database
            .prepare("SELECT * FROM room_grants WHERE agent_id=? AND room_id=?")
            .get(agentId, roomId) as unknown as RoomGrant | undefined;
    }

    public grants(agentId: string): RoomGrant[] {
        return this.database
            .prepare("SELECT * FROM room_grants WHERE agent_id=?")
            .all(agentId) as unknown as RoomGrant[];
    }

    public controls(agentId: string): RoomControl[] {
        return this.database
            .prepare("SELECT * FROM room_controls WHERE agent_id=? AND delivered=0 ORDER BY rowid")
            .all(agentId) as unknown as RoomControl[];
    }

    public controlReply(agentId: string, eventId: string, reply: string): void {
        this.database
            .prepare("UPDATE room_controls SET reply=? WHERE agent_id=? AND event_id=? AND reply IS NULL")
            .run(reply, agentId, eventId);
    }

    public controlPending(agentId: string, eventId: string): boolean {
        return !!this.database
            .prepare("SELECT 1 FROM room_controls WHERE agent_id=? AND event_id=? AND delivered=0")
            .get(agentId, eventId);
    }

    public controlDelivered(agentId: string, eventId: string): void {
        this.database
            .prepare("UPDATE room_controls SET delivered=1 WHERE agent_id=? AND event_id=?")
            .run(agentId, eventId);
    }

    public roomAlreadyJoined(grant: RoomGrant): void {
        this.database
            .prepare(
                "UPDATE room_grants SET await_room=0 WHERE agent_id=? AND room_id=? AND revision=? AND state='checking'",
            )
            .run(grant.agent_id, grant.room_id, grant.revision);
    }

    public roomSync(grant: RoomGrant, token: string): void {
        this.database
            .prepare(
                "UPDATE room_grants SET sync_token=? WHERE agent_id=? AND room_id=? AND revision=? AND state='checking' AND sync_token IS NULL",
            )
            .run(token, grant.agent_id, grant.room_id, grant.revision);
    }

    public activateRoom(grant: RoomGrant, audience: string[]): boolean {
        return (
            this.database
                .prepare(
                    "UPDATE room_grants SET state='active',audience_json=? WHERE agent_id=? AND room_id=? AND revision=? AND state='checking' AND sync_token IS NOT NULL",
                )
                .run(JSON.stringify(audience), grant.agent_id, grant.room_id, grant.revision).changes === 1
        );
    }

    private blockRoom(agentId: string, roomId: string): void {
        this.database
            .prepare(
                "UPDATE room_turns SET state=CASE WHEN state='sending' THEN 'uncertain' ELSE 'blocked' END WHERE agent_id=? AND room_id=? AND state IN ('pending','sending')",
            )
            .run(agentId, roomId);
    }

    /** Suspending a revision also quarantines its queued and uncertain publications. */
    public suspendRoom(grant: RoomGrant): void {
        this.database.exec("BEGIN IMMEDIATE");
        try {
            const changed = this.database
                .prepare(
                    "UPDATE room_grants SET state='suspended' WHERE agent_id=? AND room_id=? AND revision=? AND state IN ('active','checking')",
                )
                .run(grant.agent_id, grant.room_id, grant.revision).changes;
            if (changed) this.blockRoom(grant.agent_id, grant.room_id);
            this.database.exec("COMMIT");
        } catch (error) {
            this.database.exec("ROLLBACK");
            throw error;
        }
    }

    /** Retain only IDs from discarded initial timelines, including a replay after a cursor-save interruption. */
    public ignoreRoomEvents(agentId: string, eventIds: string[]): void {
        const insert = this.database.prepare("INSERT OR IGNORE INTO room_ignored_events VALUES (?,?)");
        for (const eventId of eventIds) insert.run(agentId, eventId);
    }

    public roomEventIgnored(agentId: string, eventId: string): boolean {
        return !!this.database
            .prepare("SELECT 1 FROM room_ignored_events WHERE agent_id=? AND event_id=?")
            .get(agentId, eventId);
    }

    public admitRoom(grant: RoomGrant, eventId: string, sender: string, body: string): void {
        this.database
            .prepare(`INSERT OR IGNORE INTO room_turns (agent_id,event_id,room_id,revision,sender,body)
            SELECT agent_id,?,room_id,revision,?,? FROM room_grants
            WHERE agent_id=? AND room_id=? AND revision=? AND state='active'`)
            .run(eventId, sender, body, grant.agent_id, grant.room_id, grant.revision);
    }

    public roomTurns(grant: RoomGrant): RoomTurn[] {
        return this.database
            .prepare(
                "SELECT * FROM room_turns WHERE agent_id=? AND room_id=? AND revision=? AND state IN ('pending','sending') ORDER BY rowid",
            )
            .all(grant.agent_id, grant.room_id, grant.revision) as unknown as RoomTurn[];
    }

    public roomAnswer(turn: RoomTurn, answer: string): void {
        this.database
            .prepare("UPDATE room_turns SET answer=? WHERE agent_id=? AND event_id=? AND state='pending'")
            .run(answer, turn.agent_id, turn.event_id);
    }

    public roomSending(turn: RoomTurn, encrypted: string): boolean {
        return (
            this.database
                .prepare(`UPDATE room_turns SET state='sending',encrypted_json=? WHERE agent_id=? AND event_id=? AND state IN ('pending','sending')
            AND EXISTS (SELECT 1 FROM room_grants WHERE agent_id=? AND room_id=? AND revision=? AND state='active')`)
                .run(encrypted, turn.agent_id, turn.event_id, turn.agent_id, turn.room_id, turn.revision).changes === 1
        );
    }

    public roomDelivered(turn: RoomTurn): void {
        this.database
            .prepare(
                "UPDATE room_turns SET state='delivered' WHERE agent_id=? AND event_id=? AND state IN ('sending','uncertain')",
            )
            .run(turn.agent_id, turn.event_id);
    }

    public close(): void {
        this.database.close();
    }
}
