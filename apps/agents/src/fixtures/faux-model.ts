/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

// Loaded explicitly by the real Matrix integration test, never by the service entrypoint.
import { mock } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PiConversation } from "../pi.ts";

if (process.env.NODE_ENV !== "test") throw new Error("Test fixture requires NODE_ENV=test");
mock.method(PiConversation, "open", async (path: string, name: string, description: string) => {
    const models = createModels();
    const faux = fauxProvider();
    faux.setResponses(Array.from({ length: 50 }, () => fauxAssistantMessage("Pi respondeu pela DM criptografada.")));
    models.setProvider(faux.provider);
    const harness = await Harness.open(
        await openNodeSqliteStorage(path),
        { models, registry: createRegistry() },
        BACKGROUND_CONTEXT,
    );
    await harness.root(BACKGROUND_CONTEXT, {
        agent: {
            model: { provider: "faux", modelId: "faux-1" },
            instructions: `${name}. ${description}`,
        },
    });
    harness.resume();
    return new PiConversation(harness);
});
