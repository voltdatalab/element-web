/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readPilotConfiguration } from "./pilotConfiguration.ts";
import type { PilotServer } from "./PilotServer.ts";

/** Start from one explicit private file; embedding callers own close(), not global signal handlers. */
export async function startPilotFromFile(path: string): Promise<PilotServer> {
    const config = readPilotConfiguration(path);
    const { PilotServer } = await import("./PilotServer.ts");
    const pilot = new PilotServer(config);
    try {
        await pilot.start();
        return pilot;
    } catch (error) {
        await pilot.close();
        throw error;
    }
}

async function main(args: string[]): Promise<void> {
    if (args.length !== 1) throw new Error("Pilot unavailable");
    const config = readPilotConfiguration(args[0]);
    const { PilotServer } = await import("./PilotServer.ts");
    const pilot = new PilotServer(config);
    let stopped = false;
    const shutdown = (): void => {
        stopped = true;
        void pilot
            .close()
            .then(() => {
                process.removeListener("SIGTERM", shutdown);
                process.removeListener("SIGINT", shutdown);
            })
            .catch(() => {
                process.stderr.write("pilot_unavailable\n");
                process.exitCode = 1;
            });
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    try {
        await pilot.start();
        if (!stopped) process.stdout.write("pilot_ready\n");
    } catch (error) {
        process.removeListener("SIGTERM", shutdown);
        process.removeListener("SIGINT", shutdown);
        await pilot.close();
        throw error;
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void main(process.argv.slice(2)).catch(() => {
        process.stderr.write("pilot_unavailable\n");
        process.exitCode = 1;
    });
}
