/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createMachineTools } from "./machineTools.ts";
import type { FirecrackerMachine } from "./FirecrackerMachine.ts";
import type { MachineArtifact } from "./MachineArtifact.ts";
import { CodexAccessCredentials } from "./CodexAccessCredentials.ts";
import { PiConversation, createInstallationModels, guardRoomModels } from "./pi.ts";

void test("real Pi storage deduplicates the Matrix event across reopening", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "clawdia-pi-"));
    const models = createModels();
    const provider = fauxProvider();
    provider.setResponses([fauxAssistantMessage("Olá, BizzAdd.")]);
    models.setProvider(provider.provider);
    const storagePath = path.join(dir, "pi.sqlite");
    let harness = await Harness.open(
        await openNodeSqliteStorage(storagePath),
        { models, registry: createRegistry() },
        BACKGROUND_CONTEXT,
    );
    try {
        await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
        let conversation = new PiConversation(harness);
        assert.equal(await conversation.reply("$message", "Olá"), "Olá, BizzAdd.");
        await conversation.close();
        harness = await Harness.open(
            await openNodeSqliteStorage(storagePath),
            { models, registry: createRegistry() },
            BACKGROUND_CONTEXT,
        );
        conversation = new PiConversation(harness);
        assert.equal(await conversation.reply("$message", "Olá"), "Olá, BizzAdd.");
    } finally {
        await harness.close(BACKGROUND_CONTEXT);
        rmSync(dir, { recursive: true, force: true });
    }
});

void test("selects Codex explicitly and resolves only the lab access credential", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "clawdia-auth-"));
    const file = path.join(dir, "access.json");
    const initial = JSON.stringify({ access: "lab-only-token", expires: Date.now() + 3_600_000 });
    writeFileSync(file, initial, { mode: 0o600 });
    try {
        const { models, provider } = createInstallationModels({
            PI_PROVIDER: "openai-codex",
            PI_CODEX_ACCESS_FILE: file,
            OPENAI_API_KEY: "must-not-use-this-provider",
        });
        assert.equal(provider, "openai-codex");
        assert.ok(models.getModel(provider, "gpt-6.1-sol"));
        assert.equal((await models.getAuth(provider))?.auth.apiKey, "lab-only-token");
        assert.equal(await models.getAuth("openai"), undefined);
        const store = new CodexAccessCredentials(file);
        assert.deepEqual(await store.list(), [{ providerId: "openai-codex", type: "oauth" }]);
        assert.equal(await store.read("openai"), undefined);
        await assert.rejects(store.modify(), /model_credential_read_only/);
        await assert.rejects(store.delete(), /model_credential_read_only/);
        assert.equal(readFileSync(file, "utf8"), initial);
        writeFileSync(file, JSON.stringify({ access: "replaced-by-owner", expires: Date.now() + 3_600_000 }));
        assert.equal((await models.getAuth(provider))?.auth.apiKey, "replaced-by-owner");
        writeFileSync(file, JSON.stringify({ access: "expired", expires: Date.now() + 60_000 }));
        await assert.rejects(store.read(provider), /model_credential_expired/);
        await assert.rejects(models.getAuth(provider));
        for (const content of ["null", "{}", "invalid-json", '{"access":42,"expires":9999999999999}']) {
            writeFileSync(file, content);
            await assert.rejects(store.read(provider), /model_credential_invalid/);
        }
        rmSync(file);
        await assert.rejects(store.read(provider), /model_credential_invalid/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

void test("keeps API-key support and rejects missing or unknown provider configuration", async () => {
    const { models, provider } = createInstallationModels({ OPENAI_API_KEY: "test-only-api-key" });
    assert.equal(provider, "openai");
    assert.equal((await models.getAuth(provider))?.auth.apiKey, "test-only-api-key");
    assert.throws(() => createInstallationModels({}), /model_not_configured/);
    assert.throws(
        () => createInstallationModels({ PI_PROVIDER: "openai-codex", OPENAI_API_KEY: "wrong" }),
        /model_not_configured/,
    );
    assert.throws(() => createInstallationModels({ PI_PROVIDER: "unknown" }), /model_provider_not_supported/);
});

void test("Pi invokes the bound workspace tools and records the real artifact once", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "clawdia-tools-"));
    const models = createModels();
    const faux = fauxProvider();
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall("write_file", { path: "report.txt", content: "From Pi" }), {
            stopReason: "toolUse",
        }),
        fauxAssistantMessage("Arquivo pronto."),
    ]);
    models.setProvider(faux.provider);
    const calls: string[] = [];
    const artifacts: MachineArtifact[] = [];
    const machine = {
        file: async (op: string, id: string, path: string, content: string) => {
            calls.push(`${op}:${path}`);
            return { path, content, sha256: "verified-by-machine-client" };
        },
    } as unknown as FirecrackerMachine;
    const registry = createRegistry();
    registry.install(createMachineTools(machine, (_id, file) => artifacts.push(file)));
    const harness = await Harness.open(
        await openNodeSqliteStorage(path.join(dir, "pi.sqlite")),
        { models, registry },
        BACKGROUND_CONTEXT,
    );
    try {
        await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
        const conversation = new PiConversation(harness);
        assert.equal(await conversation.reply("$files", "Crie um arquivo"), "Arquivo pronto.");
        assert.equal(await conversation.reply("$files", "Crie um arquivo"), "Arquivo pronto.");
        assert.deepEqual(calls, ["write:report.txt"]);
        assert.equal(artifacts[0].content, "From Pi");
    } finally {
        await harness.close(BACKGROUND_CONTEXT);
        rmSync(dir, { recursive: true, force: true });
    }
});

void test("room models deny dispatch and deferred recovery even when a Pi extension error would be ignored", async () => {
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("allowed")]);
    let allowed = true;
    guardRoomModels(models, async () => {
        if (!allowed) throw new Error("room_revoked");
    });
    assert.equal((await models.completeSimple(faux.getModel(), { messages: [] })).stopReason, "stop");
    assert.equal(faux.state.callCount, 1);
    allowed = false;
    const denied = await models.completeSimple(faux.getModel(), { messages: [] });
    assert.equal(denied.stopReason, "error");
    assert.match(denied.errorMessage ?? "", /room_revoked/);
    assert.equal(faux.state.callCount, 1);
    const deferred = await models.fetchDeferred(faux.getModel(), {
        id: "held",
        provider: "faux",
        modelId: "faux-1",
        api: faux.api,
    });
    assert.equal(deferred.stopReason, "error");
    assert.equal(faux.state.deferredFetchCount, 0);
});

void test("real Pi SQLite keeps the DM sentinel and machine tools out of the room conversation", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "clawdia-room-pi-"));
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    const inputs: string[] = [];
    let allowed = true;
    const authorize = async () => {
        if (!allowed) throw new Error("room_revoked");
    };
    const open = async (file: string, registry: ReturnType<typeof createRegistry>) => {
        const harness = await Harness.open(
            await openNodeSqliteStorage(path.join(dir, file)),
            { models, registry },
            BACKGROUND_CONTEXT,
        );
        await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
        return harness;
    };
    const privateRegistry = createRegistry();
    privateRegistry.install(createMachineTools({} as FirecrackerMachine, () => {}));
    const privateHarness = await open("private.sqlite", privateRegistry);
    let roomHarness: Harness | undefined;
    try {
        faux.setResponses([fauxAssistantMessage("private answer")]);
        await new PiConversation(privateHarness).reply("$dm", "PRIVATE_SENTINEL");
        const roomRegistry = createRegistry();
        assert.equal(roomRegistry.snapshot().tools().length, 0);
        guardRoomModels(models, authorize);
        faux.setResponses([
            (context) => {
                inputs.push(JSON.stringify(context));
                return fauxAssistantMessage("Resposta da sala");
            },
        ]);
        roomHarness = await open("room.sqlite", roomRegistry);
        const conversation = new PiConversation(roomHarness, authorize);
        assert.equal(
            await conversation.reply("$room", "Solicitante Matrix: @b:test\nPergunta compartilhada"),
            "Resposta da sala",
        );
        assert.ok(inputs.every((input) => !input.includes("PRIVATE_SENTINEL")));
        const root = await roomHarness.root(BACKGROUND_CONTEXT);
        assert.ok(!JSON.stringify(await root.context(BACKGROUND_CONTEXT)).includes("PRIVATE_SENTINEL"));
        const count = faux.state.callCount;
        allowed = false;
        await conversation.abort();
        await assert.rejects(conversation.reply("$denied", "new input"), /room_revoked/);
        assert.equal(faux.state.callCount, count);
    } finally {
        await roomHarness?.close(BACKGROUND_CONTEXT);
        await privateHarness.close(BACKGROUND_CONTEXT);
        rmSync(dir, { recursive: true, force: true });
    }
});

void test("a provider payload retry is denied after revocation instead of relying on a Pi hook exception", async () => {
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    let allowed = true;
    let sent = 0;
    guardRoomModels(models, async () => {
        if (!allowed) throw new Error("room_revoked");
    });
    faux.setResponses([
        async (_context, options) => {
            allowed = false;
            await options?.onPayload?.({ retry: true }, faux.getModel());
            sent += 1;
            return fauxAssistantMessage("must not send");
        },
    ]);
    const answer = await models.completeSimple(faux.getModel(), { messages: [] });
    assert.equal(answer.stopReason, "error");
    assert.equal(sent, 0);
});

void test(
    "real Pi abort cancels an in-flight shared turn and cannot dispatch a later input",
    { timeout: 5000 },
    async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "clawdia-revoke-pi-"));
        const models = createModels();
        const faux = fauxProvider();
        models.setProvider(faux.provider);
        let entered!: () => void;
        const started = new Promise<void>((done) => {
            entered = done;
        });
        let allowed = true;
        const authorize = async () => {
            if (!allowed) throw new Error("room_revoked");
        };
        guardRoomModels(models, authorize);
        faux.setResponses([
            async (_context, options) => {
                entered();
                await new Promise<void>((_resolve, reject) => {
                    const signal = options!.signal!;
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                    if (signal.aborted) reject(signal.reason);
                });
                return fauxAssistantMessage("must not finish");
            },
        ]);
        const harness = await Harness.open(
            await openNodeSqliteStorage(path.join(dir, "room.sqlite")),
            { models, registry: createRegistry() },
            BACKGROUND_CONTEXT,
        );
        try {
            await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
            const conversation = new PiConversation(harness, authorize);
            const outcome = conversation.reply("$pending", "Pending turn").then(
                () => "answered",
                () => "blocked",
            );
            await started;
            allowed = false;
            await conversation.abort();
            assert.equal(await outcome, "blocked");
            await assert.rejects(conversation.reply("$new", "Denied"), /room_revoked/);
            assert.equal(faux.state.callCount, 1);
        } finally {
            await harness.close(BACKGROUND_CONTEXT);
            rmSync(dir, { recursive: true, force: true });
        }
    },
);
