/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentStore } from "./store.ts";

void test("creation retry recovers the same private agent and rejects a changed payload", () => {
    const store = new AgentStore(":memory:");
    try {
        const first = store.create("@owner:test", "key", "Analista", "Pesquisa");
        assert.equal(store.create("@owner:test", "key", "Analista", "Pesquisa").id, first.id);
        assert.throws(() => store.create("@owner:test", "key", "Outro", "Pesquisa"), /request_conflict/);
        assert.notEqual(store.create("@other:test", "key", "Analista", "Pesquisa").id, first.id);
        assert.equal(store.all().length, 2);
    } finally {
        store.close();
    }
});

void test("adding room access preserves the legacy DM queue without importing any row into a shared scope", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "clawdia-legacy-store-"));
    const filename = path.join(dir, "agents.sqlite");
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
        CREATE TABLE agents (id TEXT PRIMARY KEY,owner TEXT,request_key TEXT,name TEXT,description TEXT,
            status TEXT,password TEXT,bot_token TEXT,room_id TEXT,UNIQUE(owner,request_key));
        CREATE TABLE messages (event_id TEXT PRIMARY KEY,agent_id TEXT,body TEXT,answer TEXT,delivered INTEGER DEFAULT 0);
        INSERT INTO agents VALUES ('agent','@owner:test','key','Agent','','ready','','test-only','!private:test');
        INSERT INTO messages VALUES ('$private','agent','PRIVATE_SENTINEL','private answer',0);
    `);
    legacy.close();
    let store = new AgentStore(filename);
    try {
        assert.deepEqual(
            store.pending("agent").map((row) => ({ ...row })),
            [{ event_id: "$private", body: "PRIVATE_SENTINEL", answer: "private answer" }],
        );
        assert.deepEqual(store.grants("agent"), []);
        assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM room_turns").get()?.count, 0);
        store.close();
        store = new AgentStore(filename);
        assert.equal(store.pending("agent").length, 1);
        assert.equal(store.get("agent")?.room_id, "!private:test");
    } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

void test("partial provisioning and admitted messages survive a service restart", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "clawdia-store-"));
    let store = new AgentStore(path.join(dir, "agents.sqlite"));
    try {
        const agent = store.create("@owner:test", "request", "Analista", "");
        store.token(agent.id, "test-only-token");
        store.room(agent.id, "!dm:test");
        store.admit(agent, "$event", "Olá");
        store.admit(agent, "$event", "Olá");
        store.answer("$event", "Resposta confirmada");
        store.close();
        store = new AgentStore(path.join(dir, "agents.sqlite"));
        assert.equal(store.get(agent.id)?.password, "");
        assert.equal(store.get(agent.id)?.room_id, "!dm:test");
        assert.deepEqual(
            store.pending(agent.id).map((row) => ({ ...row })),
            [{ event_id: "$event", body: "Olá", answer: "Resposta confirmada" }],
        );
        store.delivered("$event");
        assert.deepEqual(store.pending(agent.id), []);
    } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

void test("artifact outbox survives reopening and never republishes a replayed call", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "clawdia-artifacts-"));
    const file = { path: "report.txt", content: "Persisted file", sha256: "verified-in-client" };
    let store = new AgentStore(path.join(dir, "agents.sqlite"));
    try {
        store.artifact("agent-1", "call-1", file);
        store.artifact("agent-1", "call-1", file);
        assert.deepEqual(store.pendingArtifacts("agent-2"), []);
        assert.equal(store.pendingArtifacts("agent-1").length, 1);
        assert.throws(() => store.artifact("agent-1", "call-1", { ...file, sha256: "changed" }), /artifact_conflict/);
        store.artifactMedia("agent-1", "call-1", '{"url":"mxc://lab/file"}');
        store.close();
        store = new AgentStore(path.join(dir, "agents.sqlite"));
        assert.equal(store.pendingArtifacts("agent-1")[0].media_json, '{"url":"mxc://lab/file"}');
        store.artifactDelivered("agent-1", "call-1");
        store.artifact("agent-1", "call-1", file);
        assert.deepEqual(store.pendingArtifacts("agent-1"), []);
    } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
