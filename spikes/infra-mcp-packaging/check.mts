/*
Copyright 2026 Volt Data Lab
SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE-AGPL-3.0 in the repository root for full details.
*/

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import path from "node:path";

const { join } = path;

/** Read only a bounded regular file, never following its final symlink. */
function readBytes(path: string, limit: number): Buffer {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > limit) throw new Error();
        const chunks: Buffer[] = [];
        let total = 0;
        for (;;) {
            const chunk = Buffer.alloc(Math.min(65536, limit - total + 1));
            const length = readSync(fd, chunk);
            if (!length) break;
            total += length;
            if (total > limit) throw new Error();
            chunks.push(chunk.subarray(0, length));
        }
        return Buffer.concat(chunks);
    } finally {
        closeSync(fd);
    }
}

/** Require a JSON object rather than coercing a malformed manifest. */
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
}

/** Restrict this candidate layout to flat source files and named support files. */
function permitted(name: string): boolean {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) return false;
    if (/CapRover|\.test\.|fixture|^run\.ts$|^exercise\.ts$/i.test(name)) return false;
    return (
        name.endsWith(".ts") ||
        ["package.json", "pnpm-lock.yaml", "LICENSE-AGPL-3.0", "LICENSE-COMMERCIAL", "LICENSE-GPL-3.0"].includes(name)
    );
}

try {
    const args = process.argv.slice(2);
    if (args.length !== 3) throw new Error();
    const [manifestPath, profile, root] = args;
    const manifest = object(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readBytes(manifestPath, 1048576))),
    );
    if (Object.keys(manifest).sort().join(",") !== "profiles,version" || manifest.version !== 1) throw new Error();
    const profiles = object(manifest.profiles);
    if (!Object.hasOwn(profiles, profile)) throw new Error();
    const files = object(profiles[profile]);
    const names = Object.keys(files).sort();
    if (!names.length || names.length > 256) throw new Error();
    for (const name of names) {
        if (!permitted(name) || typeof files[name] !== "string" || !/^[a-f0-9]{64}$/.test(files[name])) {
            throw new Error();
        }
    }
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error();
    const actualNames = readdirSync(root).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(names)) throw new Error();
    for (const name of names) {
        const path = join(root, name);
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
        const actual = createHash("sha256").update(readBytes(path, 16777216)).digest("hex");
        if (actual !== files[name]) throw new Error();
    }
    console.log(JSON.stringify({ status: "FILES_MATCH", files: names.length }));
} catch {
    console.error("FILES_REJECTED");
    process.exitCode = 1;
}
