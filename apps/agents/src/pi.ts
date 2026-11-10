/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { AssistantEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

/** Durable Pi conversation with the installation's explicitly configured OpenAI model. */
export class PiConversation {
    private readonly harness: Harness;

    public constructor(harness: Harness) {
        this.harness = harness;
    }

    public static async open(
        path: string,
        name: string,
        description: string,
        modelId: string,
    ): Promise<PiConversation> {
        if (!process.env.OPENAI_API_KEY) throw new Error("model_not_configured");
        const models = createModels();
        models.setProvider(openaiProvider());
        if (!models.getModel("openai", modelId)) throw new Error("model_not_supported");
        const harness = await Harness.open(
            await openNodeSqliteStorage(path),
            { models, registry: createRegistry() },
            BACKGROUND_CONTEXT,
        );
        try {
            await harness.root(BACKGROUND_CONTEXT, {
                agent: {
                    model: { provider: "openai", modelId },
                    instructions: `Your name is ${name}. ${description} Reply in the user's language.`,
                    maxTurns: 4,
                },
            });
            harness.resume();
            return new PiConversation(harness);
        } catch (error) {
            await harness.close(BACKGROUND_CONTEXT);
            throw error;
        }
    }

    public async reply(eventId: string, text: string): Promise<string> {
        const root = await this.harness.root(BACKGROUND_CONTEXT);
        const submission = await root.submit({ type: "input", requestId: eventId, content: text }, BACKGROUND_CONTEXT);
        const settled = await submission.wait(BACKGROUND_CONTEXT);
        if (settled.status !== "done" || settled.type !== "input") throw new Error("model_turn_failed");
        const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
        const content = answer?.model
            ?.map((message) =>
                message.role === "assistant"
                    ? message.content
                          .filter((part) => part.type === "text")
                          .map((part) => part.text)
                          .join("")
                    : "",
            )
            .filter(Boolean)
            .join("\n");
        if (!content) throw new Error("model_answer_empty");
        return content;
    }

    public async close(): Promise<void> {
        await this.harness.close(BACKGROUND_CONTEXT);
    }
}
