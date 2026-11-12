/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PiConversation, guardRoomModels } from "../pi.ts";

/** Explicit browser-test fixture: real Pi/SQLite and deterministic responses, without credentials or machines. */
export async function openSharedTestConversation(
    ...args: Parameters<typeof PiConversation.open>
): Promise<PiConversation> {
    const [file, name, description, , workspace, authorize] = args;
    if (workspace) throw new Error("Shared browser fixture must never access a machine");
    await authorize?.();
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    faux.setResponses(
        Array.from({ length: 30 }, () => (context) => {
            if (file.includes("/rooms/") && JSON.stringify(context).includes("PRIVATE_SENTINEL"))
                throw new Error("private_context_leaked");
            return fauxAssistantMessage("Resposta de teste.");
        }),
    );
    if (authorize) guardRoomModels(models, authorize);
    const harness = await Harness.open(
        await openNodeSqliteStorage(file),
        { models, registry: createRegistry() },
        BACKGROUND_CONTEXT,
    );
    try {
        await harness.root(BACKGROUND_CONTEXT, {
            agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: `${name}. ${description}` },
        });
        await authorize?.();
        harness.resume();
        return new PiConversation(harness, authorize);
    } catch (error) {
        await harness.close(BACKGROUND_CONTEXT);
        throw error;
    }
}
