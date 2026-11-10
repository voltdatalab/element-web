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
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PiConversation } from "./pi.ts";

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
