/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { AgentStore } from "./store.ts";
import { createAgentHttpServer, agentEnvironment } from "./server.ts";
import type { AgentManager } from "./matrix.ts";

void test("element-agents deployment settings override legacy settings without widening an empty allowlist", () => {
    const config = agentEnvironment({
        ELEMENT_AGENTS_ALLOWED_USERS: "@current:test",
        CLAWDIA_ALLOWED_USERS: "@legacy:test",
        ELEMENT_AGENTS_STATE_DIR: "/existing/agents",
        CLAWDIA_STATE_DIR: "/other/agents",
    });
    assert.deepEqual([...config.allowed], ["@current:test"]);
    assert.equal(config.stateDir, "/existing/agents");
    assert.equal(
        agentEnvironment({ ELEMENT_AGENTS_ALLOWED_USERS: "", CLAWDIA_ALLOWED_USERS: "@legacy:test" }).allowed.size,
        0,
    );
});

void test("legacy deployment settings retain the existing agent state and identities", () => {
    const config = agentEnvironment({
        CLAWDIA_ALLOWED_USERS: "@owner:test",
        CLAWDIA_STATE_DIR: "/existing/private-state",
    });
    assert.deepEqual([...config.allowed], ["@owner:test"]);
    assert.equal(config.stateDir, "/existing/private-state");
});

void test("image state defaults preserve explicit legacy and canonical directories", () => {
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const stateSetting = dockerfile.match(/^ENV (\w+)=\/data /m)?.[1];
    assert.ok(stateSetting);
    const imageEnvironment = { [stateSetting]: "/data" };
    assert.equal(agentEnvironment(imageEnvironment).stateDir, "/data");
    assert.equal(
        agentEnvironment({ ...imageEnvironment, CLAWDIA_STATE_DIR: "/existing/private-state" }).stateDir,
        "/existing/private-state",
    );
    assert.equal(
        agentEnvironment({
            ...imageEnvironment,
            CLAWDIA_STATE_DIR: "/existing/private-state",
            ELEMENT_AGENTS_STATE_DIR: "/selected/private-state",
        }).stateDir,
        "/selected/private-state",
    );
});

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
