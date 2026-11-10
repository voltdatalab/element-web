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
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodexAccessCredentials } from "./CodexAccessCredentials.ts";
import { PiConversation, createInstallationModels } from "./pi.ts";

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
