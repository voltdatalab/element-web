/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { createConnection } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import type { MachineArtifact } from "./MachineArtifact.ts";

/** Client bound by the trusted product service to exactly one registered agent. */
export class FirecrackerMachine {
    private readonly socket: string;
    private readonly agentId: string;

    public constructor(socket: string, agentId: string) {
        this.socket = socket;
        this.agentId = agentId;
    }

    public request(
        op: "ensure" | "restart" | "read" | "write",
        requestId: string,
        args: object = {},
    ): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const connection = createConnection(this.socket);
            const chunks: Buffer[] = [];
            let size = 0;
            let done = false;
            const fail = (): void => {
                if (done) return;
                done = true;
                connection.destroy();
                reject(new Error("machine_operation_failed"));
            };
            connection.setTimeout(60_000, fail);
            connection.once("error", fail);
            connection.once("end", () => {
                if (!done) fail();
            });
            connection.once("connect", () => {
                connection.write(JSON.stringify({ ...args, op, requestId, agentId: this.agentId }) + "\n");
            });
            connection.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > 512_000) return fail();
                chunks.push(chunk);
                if (!chunk.includes(10)) return;
                try {
                    const response = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                        ok?: boolean;
                        result?: unknown;
                    };
                    if (!response.ok) return fail();
                    done = true;
                    connection.destroy();
                    resolve(response.result);
                } catch {
                    fail();
                }
            });
        });
    }

    public ensure(): Promise<unknown> {
        return this.request("ensure", randomUUID());
    }

    public async file(
        op: "read" | "write",
        requestId: string,
        path: string,
        content?: string,
    ): Promise<MachineArtifact> {
        const file = (await this.request(op, requestId, {
            path,
            ...(op === "write" ? { content } : {}),
        })) as MachineArtifact;
        if (
            !file ||
            file.path !== path ||
            typeof file.content !== "string" ||
            Buffer.byteLength(file.content) > 65_536 ||
            createHash("sha256").update(file.content).digest("hex") !== file.sha256
        )
            throw new Error("machine_artifact_invalid");
        return { path: file.path, content: file.content, sha256: file.sha256 };
    }
}
