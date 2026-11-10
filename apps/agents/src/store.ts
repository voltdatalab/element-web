/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

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
            CREATE TABLE IF NOT EXISTS messages (
                event_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, body TEXT NOT NULL,
                answer TEXT, delivered INTEGER NOT NULL DEFAULT 0
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

    public delivered(eventId: string): void {
        this.database.prepare("UPDATE messages SET delivered = 1 WHERE event_id = ?").run(eventId);
    }

    public close(): void {
        this.database.close();
    }
}
