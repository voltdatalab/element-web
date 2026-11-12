/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { AgentMatrixClient } from "./AgentMatrixClient.ts";
import type { SharingSync } from "./roomSharingTypes.ts";

class TestClient extends AgentMatrixClient {
    public run(batch: SharingSync): Promise<void> {
        return this.processSync(batch);
    }
    public get savesAfterAdmission(): boolean {
        return this.persistTokenAfterSync;
    }
}

void test("sync brackets event admission, persists its cursor afterwards, and never autojoins invitations", async () => {
    const bot = new TestClient("https://test.invalid", "not-a-real-token");
    const sequence: string[] = [];
    mock.method(bot, "getUserId", async () => "@bot:test");
    const joins = mock.method(bot, "joinRoom", async () => "!room:test");
    bot.beforeSync = () => {
        sequence.push("before");
    };
    bot.afterSync = () => {
        sequence.push("after");
    };
    bot.on("room.message", () => {
        sequence.push("admit");
    });
    await bot.run({
        next_batch: "cursor",
        rooms: {
            join: {
                "!room:test": {
                    timeline: {
                        events: [
                            {
                                event_id: "$text",
                                sender: "@a:test",
                                type: "m.room.message",
                                content: { msgtype: "m.text", body: "Hi" },
                            },
                        ],
                    },
                },
            },
        },
    });
    assert.equal(bot.savesAfterAdmission, true);
    assert.deepEqual(sequence, ["before", "admit", "after"]);
    assert.equal(joins.mock.callCount(), 0);
});

void test("failed admission stops sync instead of continuing from an advanced in-memory cursor", async () => {
    const bot = new TestClient("https://test.invalid", "not-a-real-token");
    const stop = mock.method(bot, "stop");
    bot.beforeSync = () => {
        throw new Error("sqlite_failure");
    };
    await assert.rejects(bot.run({ next_batch: "cursor" }), /sqlite_failure/);
    assert.equal(stop.mock.callCount(), 1);
});
