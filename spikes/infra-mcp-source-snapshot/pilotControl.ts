/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { lstatSync } from "node:fs";
import { request } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { assertPilotPath, assertPrivatePilotDirectory } from "./pilot-private-path.ts";
import { parsePilotConfiguration, readPilotConfiguration, type PilotConfiguration } from "./pilotConfiguration.ts";
import { infraRuntimeScope } from "./infraRuntimeTypes.ts";
import type { PilotControlAction, PilotControlStatus } from "./pilot-control-types.ts";

/** Call only the fixed private Unix operator endpoint; never uses TCP, ambient credentials or model arguments. */
export async function controlPilot(
    configuration: PilotConfiguration,
    action: PilotControlAction,
): Promise<PilotControlStatus> {
    try {
        const config = parsePilotConfiguration(configuration);
        if (!["status", "revoke", "restore"].includes(action)) throw new Error();
        assertPilotPath(config.operatorSocketPath);
        assertPrivatePilotDirectory(dirname(config.operatorSocketPath));
        const stat = lstatSync(config.operatorSocketPath);
        if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600) throw new Error();
        const bytes = await new Promise<Buffer>((resolve, reject) => {
            const req = request(
                {
                    socketPath: config.operatorSocketPath,
                    path: `/${action}`,
                    method: "POST",
                    agent: false,
                    maxHeaderSize: 8192,
                    headers: { "Content-Length": "0" },
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    let size = 0;
                    if (res.statusCode !== 200 || res.headers["content-encoding"] !== undefined) {
                        req.destroy(new Error());
                        return;
                    }
                    res.on("data", (chunk: Buffer) => {
                        size += chunk.length;
                        if (size > 16384) req.destroy(new Error());
                        else chunks.push(chunk);
                    });
                    res.on("end", () => {
                        if (res.complete) resolve(Buffer.concat(chunks));
                        else reject(new Error());
                    });
                    res.on("error", reject);
                    res.on("aborted", () => reject(new Error()));
                },
            );
            const timer = setTimeout(() => req.destroy(new Error()), 2000);
            req.on("error", reject);
            req.on("close", () => clearTimeout(timer));
            req.end();
        });
        const status = z
            .strictObject({
                enabled: z.boolean(),
                scopes: z.array(z.literal(infraRuntimeScope(config.target))).max(1),
                client: z.strictObject({
                    clientId: z.literal(config.publicClient.clientId),
                    clientName: z.literal(config.publicClient.clientName),
                    redirectUri: z.literal(config.publicClient.redirectUri),
                }),
            })
            .parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        if (status.enabled !== (status.scopes.length === 1)) throw new Error();
        return status;
    } catch {
        throw new Error("Private operator unavailable");
    }
}

async function main(args: string[]): Promise<void> {
    if (args.length !== 2 || !["status", "revoke", "restore"].includes(args[1])) throw new Error();
    const result = await controlPilot(readPilotConfiguration(args[0]), args[1] as PilotControlAction);
    process.stdout.write(JSON.stringify(result) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void main(process.argv.slice(2)).catch(() => {
        process.stderr.write("operator_unavailable\n");
        process.exitCode = 1;
    });
}
