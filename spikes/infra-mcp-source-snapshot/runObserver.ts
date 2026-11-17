/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { assertPrivateRuntimeFile, RuntimeObserver, type RuntimeObserverConfig } from "./RuntimeObserver.ts";

/** Loads bounded UTF-8 JSON from an owner-only regular configuration file, never an environment fallback. */
export async function readRuntimeObserverConfig(configPath: string): Promise<RuntimeObserverConfig> {
    try {
        await assertPrivateRuntimeFile(configPath);
        const file = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o177) !== 0 || stat.size > 16384) {
                throw new Error("Unavailable");
            }
            const buffer = Buffer.alloc(16385);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            if (bytesRead > 16384) throw new Error("Unavailable");
            const config = JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)),
            ) as RuntimeObserverConfig;
            new RuntimeObserver(config);
            return config;
        } finally {
            await file.close();
        }
    } catch {
        throw new Error("Runtime observer unavailable");
    }
}

/** Starts the observer without signal handlers; the embedding process owns its returned lifetime. */
export async function runObserver(configPath: string): Promise<RuntimeObserver> {
    const observer = new RuntimeObserver(await readRuntimeObserverConfig(configPath));
    await observer.start();
    return observer;
}

async function main(args: string[]): Promise<void> {
    if (args.length !== 1) throw new Error("Unavailable");
    let stopping = false;
    const startup = runObserver(args[0]);
    const stop = (): void => {
        if (stopping) return;
        stopping = true;
        void startup
            .then((observer) => observer.close())
            .catch(() => {
                process.stderr.write("Runtime observer unavailable\n");
                process.exitCode = 1;
            })
            .finally(() => {
                process.removeListener("SIGTERM", stop);
                process.removeListener("SIGINT", stop);
            });
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    try {
        await startup;
        if (!stopping) process.stderr.write("Runtime observer ready\n");
    } catch {
        process.removeListener("SIGTERM", stop);
        process.removeListener("SIGINT", stop);
        throw new Error("Unavailable");
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void main(process.argv.slice(2)).catch(() => {
        process.stderr.write("Runtime observer unavailable\n");
        process.exitCode = 1;
    });
}
