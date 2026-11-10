/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { AgentStore } from "./store.ts";
import { createAgentHttpServer } from "./server.ts";
import type { AgentManager } from "./matrix.ts";

async function fixture() {
    const store = new AgentStore(":memory:");
    const manager = {
        store,
        matrixRequest: async (_path: string, token: string) => {
            if (token === "invalid") throw new Error("matrix_401");
            return { user_id: token === "other" ? "@other:test" : "@owner:test" };
        },
        ensure: async (agent: { id: string }) => {
            store.token(agent.id, "test-only-bot-secret");
            store.room(agent.id, "!private:test");
            store.status(agent.id, "ready");
        },
    };
    const server = createAgentHttpServer(manager as unknown as AgentManager, new Set(["@owner:test"]), "test");
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/clawdia/agents`;
    return {
        store,
        url,
        close: async () => {
            await new Promise<void>((done) => server.close(() => done()));
            store.close();
        },
    };
}

function request(url: string, token?: string, payload: unknown = { name: "Analista" }, key = randomUUID()) {
    return fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
    });
}

void test("requires a valid allowed Matrix identity before creating resources", async () => {
    const f = await fixture();
    try {
        assert.equal((await request(f.url)).status, 401);
        assert.equal((await request(f.url, "invalid")).status, 401);
        assert.equal((await request(f.url, "other")).status, 403);
        assert.equal(f.store.all().length, 0);
    } finally {
        await f.close();
    }
});

void test("ignores a forged owner, returns only public registration data, and deduplicates", async () => {
    const f = await fixture();
    try {
        const key = randomUUID();
        const body = { name: "Analista", owner: "@other:test" };
        const first = await request(f.url, "owner", body, key);
        const result = (await first.json()) as { id: string; roomId: string; userId: string };
        assert.equal(first.status, 200);
        assert.equal(f.store.get(result.id)?.owner, "@owner:test");
        assert.equal(result.roomId, "!private:test");
        assert.deepEqual(Object.keys(result).sort(), ["id", "roomId", "status", "userId"]);
        assert.deepEqual(await (await request(f.url, "owner", body, key)).json(), result);
        assert.equal(f.store.all().length, 1);
        assert.equal((await request(f.url, "owner", { name: "Changed" }, key)).status, 409);
    } finally {
        await f.close();
    }
});

void test("validates the creation body and bounds request size", async () => {
    const f = await fixture();
    try {
        for (const body of [null, [], { name: " " }, { name: "Agent", description: 42 }, { name: "x".repeat(9000) }]) {
            assert.equal((await request(f.url, "owner", body)).status, 400);
        }
        assert.equal(f.store.all().length, 0);
    } finally {
        await f.close();
    }
});
