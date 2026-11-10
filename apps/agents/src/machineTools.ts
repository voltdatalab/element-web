/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { FirecrackerMachine } from "./FirecrackerMachine.ts";
import type { MachineArtifact } from "./MachineArtifact.ts";

/** Expose bounded files and lifecycle only for the current agent's machine. */
export function createMachineTools(
    machine: FirecrackerMachine,
    record: (callId: string, file: MachineArtifact) => void,
): ReturnType<typeof defineExtension> {
    const path = { type: "string", minLength: 1, maxLength: 240 };
    const tools = ["write", "read"].map((op) =>
        defineTool({
            name: `${op}_file`,
            description:
                `${op === "write" ? "Create or replace" : "Read"} a UTF-8 file in your own Firecracker workspace. ` +
                "Use a relative path. A real encrypted file attachment is delivered to this DM automatically.",
            parameters: {
                type: "object",
                properties: { path, ...(op === "write" ? { content: { type: "string", maxLength: 65_536 } } : {}) },
                required: op === "write" ? ["path", "content"] : ["path"],
                additionalProperties: false,
            },
            replay: "safe",
            executionMode: "sequential",
            execute: async (raw: unknown, api) => {
                // The Harness validates the JSON Schema before execution; the guest checks paths and byte limits too.
                const args = raw as { path: string; content?: string };
                const file = await machine.file(op as "write" | "read", api.callId, args.path, args.content);
                record(api.callId, file);
                return { output: [{ type: "text", text: JSON.stringify(file) }] };
            },
        }),
    );
    const restart = defineTool({
        name: "restart_machine",
        description:
            "Stop and start your own microVM using its same persistent workspace disk. Use only when the user requests a restart. Returns a new boot ID.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        replay: "safe",
        executionMode: "sequential",
        execute: async (_args, api) => ({
            output: [{ type: "text", text: JSON.stringify(await machine.request("restart", api.callId)) }],
        }),
    });
    return defineExtension({ name: "firecracker-workspace", tools: [...tools, restart] });
}
