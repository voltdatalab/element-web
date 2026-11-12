/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { test, mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatrixClient } from "matrix-bot-sdk";
import { AgentStore } from "./store.ts";
import { RoomSharing } from "./RoomSharing.ts";
import type { SharedMessage } from "./roomSharingTypes.ts";

const owner = "@a:test";
const peer = "@b:test";
const room = "!shared:test";
const dm = "!dm:test";

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function fixture(t: TestContext) {
    const folder = await mkdtemp(path.join(tmpdir(), "clawdia-sharing-"));
    const filename = path.join(folder, "agents.sqlite");
    let store = new AgentStore(filename);
    const created = store.create(owner, "agent", "Analista", "Public agent instructions");
    store.room(created.id, dm);
    const agent = store.get(created.id)!;
    const botId = `@clawdia_${agent.id.replaceAll("-", "")}:test`;
    const members = new Map([[room, [owner, peer, botId]]]);
    const joined = new Set([dm]);
    const joins: string[] = [];
    const calls: { file: string; event: string; text: string }[] = [];
    const opened: string[] = [];
    const encrypted: { room: string; content: Record<string, unknown> }[] = [];
    const attempts: { endpoint: string; body: unknown }[] = [];
    const accepted = new Map<string, unknown>();
    let aborts = 0;
    let serial = 0;
    const hooks = {
        reply: async (): Promise<string> => "Resposta da sala",
        encrypt: async (_room: string): Promise<void> => {},
        send: async (_endpoint: string): Promise<void> => {},
        open: async (): Promise<void> => {},
        state: async (): Promise<void> => {},
        privateMembers: [owner, botId],
        algorithm: "m.megolm.v1.aes-sha2",
        joinRule: "invite",
        ownerPower: 100,
    };
    const bot = {
        getJoinedRoomMembers: async () => hooks.privateMembers,
        getJoinedRooms: async () => [...joined],
        joinRoom: async (id: string) => {
            joins.push(id);
            joined.add(id);
            return id;
        },
        getRoomState: async (id: string) => {
            await hooks.state();
            return [
                { type: "m.room.encryption", state_key: "", content: { algorithm: hooks.algorithm } },
                { type: "m.room.join_rules", state_key: "", content: { join_rule: hooks.joinRule } },
                {
                    type: "m.room.power_levels",
                    state_key: "",
                    content: { invite: 50, users: { [owner]: hooks.ownerPower } },
                },
                ...(members.get(id) ?? []).map((user) => ({
                    type: "m.room.member",
                    state_key: user,
                    content: { membership: "join" },
                })),
            ];
        },
        crypto: {
            encryptRoomEvent: async (id: string, _type: string, content: Record<string, unknown>) => {
                await hooks.encrypt(id);
                const event = { room: id, content, nonce: ++serial };
                encrypted.push(event);
                return event;
            },
        },
        doRequest: async (_method: string, endpoint: string, _query: unknown, body: unknown) => {
            attempts.push({ endpoint, body });
            accepted.set(endpoint, body);
            await hooks.send(endpoint);
            return { event_id: "$sent" };
        },
    };
    const config = { serverName: "test", stateDir: folder, model: "faux-1" };
    const build = () =>
        new RoomSharing(agent, bot as unknown as MatrixClient, store, config, async (file, authorize) => {
            await hooks.open();
            await authorize();
            opened.push(file);
            return {
                reply: async (event, text) => {
                    await authorize();
                    calls.push({ file, event, text });
                    return hooks.reply();
                },
                abort: async () => {
                    aborts += 1;
                },
                close: async () => {},
            };
        });
    let sharing = build();
    const message = (id: string, sender = peer, body = "Olá", mention = true): SharedMessage => ({
        event_id: id,
        sender,
        type: "m.room.message",
        content: { msgtype: "m.text", body, ...(mention ? { "m.mentions": { user_ids: [botId] } } : {}) },
    });
    const command = (id: string, action = "compartilhar", target = room, sender = owner) =>
        sharing.receive(
            dm,
            message(id, sender, `!clawdia ${action} https://matrix.to/#/${encodeURIComponent(target)}`),
        );
    const activate = async (id = "$share") => {
        command(id);
        await sharing.tick();
        assert.equal(store.grant(agent.id, room)?.state, "checking");
        const batch = { next_batch: "sync:" + id, rooms: { join: { [room]: { timeline: { events: [] } } } } };
        sharing.beforeSync(batch);
        sharing.receive(room, message("$old:" + id));
        sharing.afterSync(batch);
        await sharing.tick();
        assert.equal(store.grant(agent.id, room)?.state, "active");
    };
    t.after(async () => {
        await sharing.close();
        store.close();
        await rm(folder, { recursive: true, force: true });
    });
    return {
        get store() {
            return store;
        },
        get sharing() {
            return sharing;
        },
        agent,
        folder,
        botId,
        members,
        joined,
        joins,
        calls,
        opened,
        encrypted,
        attempts,
        accepted,
        hooks,
        message,
        command,
        activate,
        get aborts() {
            return aborts;
        },
        roomSends: () => attempts.filter((send) => send.endpoint.includes(encodeURIComponent(room))),
        restart: async () => {
            await sharing.close();
            store.close();
            store = new AgentStore(filename);
            sharing = build();
        },
    };
}

void test("only the owner controls access; the initial timeline and duplicate command cannot activate extra work", async (t) => {
    const f = await fixture(t);
    f.command("$forged", "compartilhar", room, peer);
    f.sharing.receive("!other:test", f.message("$unbound", owner));
    await f.sharing.tick();
    assert.equal(f.store.grants(f.agent.id).length, 0);
    assert.deepEqual(f.joins, []);
    await f.activate();
    f.command("$share");
    await f.sharing.tick();
    assert.equal(f.store.grant(f.agent.id, room)?.revision, 1);
    assert.equal(f.store.roomTurns(f.store.grant(f.agent.id, room)!).length, 0);
    assert.deepEqual(f.joins, [room]);
    assert.deepEqual(f.calls, []);
    await f.restart();
    f.sharing.receive(room, f.message("$old:$share"));
    await f.sharing.tick();
    assert.deepEqual(f.calls, []);
});

void test("two people mention the same agent; other rooms, nonmentions and unauthorized senders do nothing", async (t) => {
    const f = await fixture(t);
    await f.activate();
    f.sharing.receive(room, f.message("$a", owner));
    f.sharing.receive(room, f.message("$b"));
    f.sharing.receive(room, f.message("$b"));
    f.sharing.receive("!other:test", f.message("$other"));
    f.sharing.receive(room, f.message("$no-mention", peer, "Sem menção", false));
    f.sharing.receive(room, f.message("$stranger", "@stranger:test"));
    f.sharing.receive(room, f.message("$command-in-room", peer, "!clawdia revogar !shared:test"));
    await f.sharing.tick();
    assert.deepEqual(
        f.calls.map((call) => call.event),
        ["$a", "$b"],
    );
    assert.match(f.calls[0].text, /Solicitante Matrix: @a:test/);
    assert.match(f.calls[1].text, /Solicitante Matrix: @b:test/);
    assert.equal(new Set(f.opened).size, 1);
    assert.equal(f.roomSends().length, 2);
    assert.equal(f.store.pending(f.agent.id).length, 0);
});

void test("room processing never opens the private transcript or queries its queued artifacts", async (t) => {
    const f = await fixture(t);
    f.store.admit(f.agent, "$private", "PRIVATE_SENTINEL");
    f.store.artifact(f.agent.id, "private-file", {
        path: "private.txt",
        content: "PRIVATE_SENTINEL",
        sha256: "private-hash",
    });
    await writeFile(path.join(f.folder, "private-pi.sqlite"), "PRIVATE_SENTINEL");
    const artifacts = mock.method(f.store, "pendingArtifacts", () => {
        throw new Error("private_artifacts_accessed");
    });
    await f.activate();
    f.sharing.receive(room, f.message("$request", peer, "Leia os arquivos e o histórico da DM"));
    await f.sharing.tick();
    assert.equal(artifacts.mock.callCount(), 0);
    assert.equal(f.store.pending(f.agent.id)[0].body, "PRIVATE_SENTINEL");
    assert.ok(f.opened.every((file) => file.includes(path.sep + "rooms" + path.sep)));
    assert.ok(f.calls.every((call) => !call.text.includes("PRIVATE_SENTINEL")));
    assert.ok(f.encrypted.every((event) => event.content.msgtype === "m.text"));
    assert.ok(f.encrypted.every((event) => !JSON.stringify(event).includes("PRIVATE_SENTINEL")));
});

void test("revocation fences an admitted event synchronously and survives reopening", async (t) => {
    const f = await fixture(t);
    await f.activate();
    f.sharing.receive(room, f.message("$pending"));
    f.command("$revoke", "revogar");
    assert.equal(f.store.grant(f.agent.id, room)?.state, "revoked");
    await f.sharing.tick();
    await f.restart();
    await f.sharing.tick();
    assert.deepEqual(f.calls, []);
    assert.equal(f.roomSends().length, 0);
    assert.equal(
        f.store.database.prepare("SELECT state FROM room_turns WHERE event_id='$pending'").get()?.state,
        "blocked",
    );
});

void test("revocation while opening Pi cannot start a new model turn", async (t) => {
    const f = await fixture(t);
    await f.activate();
    const entered = deferred();
    const gate = deferred();
    f.hooks.open = async () => {
        entered.resolve();
        await gate.promise;
    };
    f.sharing.receive(room, f.message("$pending"));
    const work = f.sharing.tick();
    await entered.promise;
    f.command("$revoke", "revogar");
    await f.sharing.tick();
    gate.resolve();
    await work;
    assert.deepEqual(f.calls, []);
    assert.equal(f.roomSends().length, 0);
});

void test("revocation during generation discards the answer and blocks publication", async (t) => {
    const f = await fixture(t);
    await f.activate();
    const entered = deferred();
    const gate = deferred<string>();
    f.hooks.reply = () => {
        entered.resolve();
        return gate.promise;
    };
    f.sharing.receive(room, f.message("$pending"));
    const work = f.sharing.tick();
    await entered.promise;
    f.command("$revoke", "revogar");
    await f.sharing.tick();
    gate.resolve("must not be delivered");
    await work;
    assert.ok(f.aborts > 0);
    assert.equal(f.roomSends().length, 0);
    const row = f.store.database.prepare("SELECT state,answer FROM room_turns WHERE event_id='$pending'").get();
    assert.equal(row?.state, "blocked");
    assert.equal(row?.answer, null);
});

void test("revocation during encryption is rechecked before starting the PUT", async (t) => {
    const f = await fixture(t);
    await f.activate();
    const entered = deferred();
    const gate = deferred();
    f.hooks.encrypt = async (id) => {
        if (id === room) {
            entered.resolve();
            await gate.promise;
        }
    };
    f.sharing.receive(room, f.message("$pending"));
    const work = f.sharing.tick();
    await entered.promise;
    f.command("$revoke", "revogar");
    await f.sharing.tick();
    gate.resolve();
    await work;
    assert.equal(f.roomSends().length, 0);
});

void test("authoritative audience changes block both execution and delivery", async (t) => {
    for (const when of ["before-model", "before-send"]) {
        await t.test(when, async (context) => {
            const f = await fixture(context);
            await f.activate();
            const change = () => f.members.set(room, [owner, peer, f.botId, "@new:test"]);
            if (when === "before-model") change();
            else
                f.hooks.reply = async () => {
                    change();
                    return "old audience result";
                };
            f.sharing.receive(room, f.message("$pending"));
            await f.sharing.tick();
            assert.equal(f.store.grant(f.agent.id, room)?.state, "suspended");
            assert.equal(f.calls.length, when === "before-model" ? 0 : 1);
            assert.equal(f.roomSends().length, 0);
        });
    }
});

void test("transient membership changes and limited timelines invalidate a pending turn before admission", async (t) => {
    const f = await fixture(t);
    await f.activate();
    f.sharing.receive(room, f.message("$pending"));
    f.sharing.beforeSync({
        next_batch: "changed",
        rooms: {
            join: {
                [room]: {
                    timeline: {
                        events: [
                            {
                                event_id: "$join",
                                sender: owner,
                                type: "m.room.member",
                                state_key: "@new:test",
                                content: { membership: "join" },
                            },
                            {
                                event_id: "$leave",
                                sender: owner,
                                type: "m.room.member",
                                state_key: "@new:test",
                                content: { membership: "leave" },
                            },
                        ],
                    },
                },
            },
        },
    });
    await f.sharing.tick();
    assert.equal(f.store.grant(f.agent.id, room)?.state, "suspended");
    assert.deepEqual(f.calls, []);
    await f.activate("$reshare");
    f.sharing.receive(room, f.message("$pending-again"));
    f.sharing.beforeSync({ next_batch: "gap", rooms: { join: { [room]: { timeline: { limited: true } } } } });
    await f.sharing.tick();
    assert.equal(f.store.grant(f.agent.id, room)?.state, "suspended");
    assert.deepEqual(f.calls, []);
});

void test("active outbox recovery reuses the same encrypted event and transaction without invoking Pi again", async (t) => {
    const f = await fixture(t);
    await f.activate();
    f.hooks.send = async (endpoint) => {
        if (endpoint.includes(encodeURIComponent(room))) throw new Error("receipt_lost_after_acceptance");
    };
    f.sharing.receive(room, f.message("$pending"));
    await f.sharing.tick();
    assert.equal(f.roomSends().length, 1);
    assert.equal(f.calls.length, 1);
    const first = f.roomSends()[0];
    await f.restart();
    f.hooks.send = async () => {};
    await f.sharing.tick();
    assert.equal(f.calls.length, 1);
    assert.equal(f.opened.length, 1);
    assert.deepEqual(f.roomSends()[1], first);
    assert.equal([...f.accepted.keys()].filter((endpoint) => endpoint.includes(encodeURIComponent(room))).length, 1);
    assert.equal(
        f.store.database.prepare("SELECT state FROM room_turns WHERE event_id='$pending'").get()?.state,
        "delivered",
    );
});

void test("revocation classifies an in-flight send as uncertain and never retries it after reopening", async (t) => {
    const f = await fixture(t);
    await f.activate();
    const entered = deferred();
    const gate = deferred();
    f.hooks.send = async (endpoint) => {
        if (endpoint.includes(encodeURIComponent(room))) {
            entered.resolve();
            await gate.promise;
            throw new Error("unknown_outcome");
        }
    };
    f.sharing.receive(room, f.message("$pending"));
    const work = f.sharing.tick();
    await entered.promise;
    f.command("$revoke", "revogar");
    assert.equal(
        f.store.database.prepare("SELECT state FROM room_turns WHERE event_id='$pending'").get()?.state,
        "uncertain",
    );
    await f.sharing.tick();
    assert.equal(f.store.controls(f.agent.id).length, 0);
    gate.resolve();
    await work;
    await f.restart();
    f.hooks.send = async () => {};
    await f.sharing.tick();
    assert.equal(f.roomSends().length, 1);
    assert.equal(
        f.store.database.prepare("SELECT state FROM room_turns WHERE event_id='$pending'").get()?.state,
        "uncertain",
    );
});

void test("regranting starts a fresh context and cannot resurrect a replayed old event", async (t) => {
    const f = await fixture(t);
    await f.activate();
    f.sharing.receive(room, f.message("$first"));
    await f.sharing.tick();
    f.sharing.receive(room, f.message("$stale"));
    f.command("$revoke", "revogar");
    await f.sharing.tick();
    await f.restart();
    await f.activate("$new-share");
    f.sharing.receive(room, f.message("$stale"));
    f.sharing.receive(room, f.message("$fresh"));
    await f.sharing.tick();
    assert.equal(f.store.grant(f.agent.id, room)?.revision, 3);
    assert.deepEqual(
        f.calls.map((call) => call.event),
        ["$first", "$fresh"],
    );
    assert.equal(f.opened.length, 2);
    assert.notEqual(f.opened[0], f.opened[1]);
    assert.equal(
        f.store.database.prepare("SELECT state FROM room_turns WHERE event_id='$stale'").get()?.state,
        "blocked",
    );
});

void test("private-DM audience and room policy must be verified before sharing", async (t) => {
    for (const policy of ["private-dm", "unencrypted", "public", "foreign", "owner-power", "missing-owner"]) {
        await t.test(policy, async (context) => {
            const f = await fixture(context);
            if (policy === "private-dm") f.hooks.privateMembers.push("@stranger:test");
            if (policy === "unencrypted") f.hooks.algorithm = "none";
            if (policy === "public") f.hooks.joinRule = "public";
            if (policy === "foreign") f.members.get(room)!.push("@external:elsewhere");
            if (policy === "owner-power") f.hooks.ownerPower = 0;
            if (policy === "missing-owner") f.members.set(room, [peer, f.botId]);
            f.command("$share");
            await f.sharing.tick();
            f.sharing.afterSync({ next_batch: "boundary", rooms: { join: { [room]: {} } } });
            await f.sharing.tick();
            assert.notEqual(f.store.grant(f.agent.id, room)?.state, "active");
            assert.deepEqual(f.calls, []);
            if (policy === "private-dm") assert.deepEqual(f.joins, []);
        });
    }
});

void test("permission lookup failure suspends access instead of retrying inference with stale authorization", async (t) => {
    const f = await fixture(t);
    await f.activate();
    f.hooks.state = async () => {
        throw new Error("homeserver_unavailable");
    };
    f.sharing.receive(room, f.message("$pending"));
    await f.sharing.tick();
    f.hooks.state = async () => {};
    await f.sharing.tick();
    assert.equal(f.store.grant(f.agent.id, room)?.state, "suspended");
    assert.deepEqual(f.calls, []);
    assert.equal(f.roomSends().length, 0);
});

void test("a revoked share cannot publish its stale owner confirmation after the revoke acknowledgement", async (t) => {
    const f = await fixture(t);
    await f.activate();
    f.command("$second-share");
    await f.sharing.tick();
    f.sharing.afterSync({ next_batch: "second-boundary" });
    const entered = deferred();
    const gate = deferred();
    let once = true;
    f.hooks.encrypt = async (id) => {
        if (id === dm && once) {
            once = false;
            entered.resolve();
            await gate.promise;
        }
    };
    const work = f.sharing.tick();
    await entered.promise;
    f.command("$revoke", "revogar");
    await f.sharing.tick();
    gate.resolve();
    await work;
    assert.equal(f.store.grant(f.agent.id, room)?.state, "revoked");
    assert.equal(f.attempts.length, 2);
    assert.equal(f.store.controls(f.agent.id).length, 0);
    assert.equal(
        f.store.database.prepare("SELECT delivered FROM room_controls WHERE event_id='$second-share'").get()?.delivered,
        -1,
    );
});

void test("terminal Pi failures finish the failed turn and allow the next room message to run", async (t) => {
    for (const failure of ["model_turn_failed", "model_answer_empty"]) {
        await t.test(failure, async (context) => {
            const f = await fixture(context);
            await f.activate();
            let attempts = 0;
            f.hooks.reply = async () => {
                if (++attempts === 1) throw new Error(failure);
                return "Resposta seguinte";
            };
            f.sharing.receive(room, f.message("$failed"));
            f.sharing.receive(room, f.message("$next"));
            await f.sharing.tick();
            assert.deepEqual(
                f.calls.map((call) => call.event),
                ["$failed", "$next"],
            );
            assert.equal(f.roomSends().length, 2);
            const replies = f.encrypted.filter((event) => event.room === room).map((event) => event.content.body);
            assert.match(String(replies[0]), /response failed/i);
            assert.equal(replies[1], "Resposta seguinte");
            assert.equal(f.store.roomTurns(f.store.grant(f.agent.id, room)!).length, 0);
        });
    }
});

void test("a terminal Pi error cannot publish a failure notice after revocation", async (t) => {
    const f = await fixture(t);
    await f.activate();
    f.hooks.reply = async () => {
        f.command("$revoke", "revogar");
        throw new Error("model_turn_failed");
    };
    f.sharing.receive(room, f.message("$failed"));
    await f.sharing.tick();
    assert.equal(f.store.grant(f.agent.id, room)?.state, "revoked");
    assert.equal(f.roomSends().length, 0);
    assert.equal(
        f.store.database.prepare("SELECT state FROM room_turns WHERE event_id='$failed'").get()?.state,
        "blocked",
    );
});
