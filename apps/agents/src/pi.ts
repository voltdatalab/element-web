/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { AssistantEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createMachineTools } from "./machineTools.ts";
import type { FirecrackerMachine } from "./FirecrackerMachine.ts";
import type { MachineArtifact } from "./MachineArtifact.ts";
import { CodexAccessCredentials } from "./CodexAccessCredentials.ts";

/** Resolve only the installation's explicitly selected provider and private credentials. */
export function createInstallationModels(env: NodeJS.ProcessEnv = process.env): {
    models: ReturnType<typeof createModels>;
    provider: string;
} {
    const provider = env.PI_PROVIDER ?? "openai";
    if (provider !== "openai" && provider !== "openai-codex") throw new Error("model_provider_not_supported");
    if (provider === "openai" ? !env.OPENAI_API_KEY : !env.PI_CODEX_ACCESS_FILE)
        throw new Error("model_not_configured");
    const models = createModels({
        credentials: provider === "openai-codex" ? new CodexAccessCredentials(env.PI_CODEX_ACCESS_FILE!) : undefined,
        authContext: { env: (name) => Promise.resolve(env[name]), fileExists: () => Promise.resolve(false) },
    });
    models.setProvider(provider === "openai-codex" ? openaiCodexProvider() : openaiProvider());
    return { models, provider };
}

/** Durable Pi conversation with the installation's explicitly configured model. */
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
        workspace?: { machine: FirecrackerMachine; record: (callId: string, file: MachineArtifact) => void },
    ): Promise<PiConversation> {
        const { models, provider } = createInstallationModels();
        if (!models.getModel(provider, modelId)) throw new Error("model_not_supported");
        if (!(await models.getAuth(provider))) throw new Error("model_not_configured");
        const registry = createRegistry();
        if (workspace) registry.install(createMachineTools(workspace.machine, workspace.record));
        const harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry }, BACKGROUND_CONTEXT);
        try {
            await harness.root(BACKGROUND_CONTEXT, {
                agent: {
                    model: { provider, modelId },
                    instructions:
                        `Your name is ${name}. ${description} Reply in the user's language. ` +
                        (workspace
                            ? "Use the provided tools for all files and machine operations. Never claim a file was created or read without a successful tool result. File tools automatically attach the actual file to the DM. Your workspace is private to you and persists across machine restarts."
                            : ""),
                    maxTurns: workspace ? 8 : 4,
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
