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
