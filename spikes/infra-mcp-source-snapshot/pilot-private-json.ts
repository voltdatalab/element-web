/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    constants,
    closeSync,
    fstatSync,
    fsyncSync,
    lstatSync,
    openSync,
    readSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { assertPilotPath, assertPrivatePilotDirectory } from "./pilot-private-path.ts";

/** Read bounded private JSON through a no-follow descriptor, rejecting replacement and invalid UTF-8. */
export function readPrivatePilotJson(path: string, maxBytes = 16384): unknown {
    assertPilotPath(path);
    const before = lstatSync(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = fstatSync(fd);
        if (
            !stat.isFile() ||
            stat.uid !== process.getuid?.() ||
            (stat.mode & 0o7777) !== 0o600 ||
            stat.nlink !== 1 ||
            stat.size > maxBytes ||
            stat.ino !== before.ino ||
            stat.dev !== before.dev
        )
            throw new Error("Unsafe pilot JSON");
        const bytes = Buffer.alloc(maxBytes + 1);
        let size = 0;
        while (size < bytes.length) {
            const count = readSync(fd, bytes, size, bytes.length - size, null);
            if (!count) break;
            size += count;
        }
        const after = fstatSync(fd);
        const current = lstatSync(path);
        if (
            size > maxBytes ||
            size !== stat.size ||
            after.size !== stat.size ||
            after.mtimeMs !== stat.mtimeMs ||
            after.ctimeMs !== stat.ctimeMs ||
            current.ino !== stat.ino ||
            current.dev !== stat.dev ||
            current.isSymbolicLink()
        )
            throw new Error("Unsafe pilot JSON");
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
        const parsed: unknown = JSON.parse(text);
        // JSON.parse silently chooses the last duplicate key. Installation policy must never be ambiguous.
        const objects: (Set<string> | null)[] = [];
        for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]]/g)) {
            if (token[0] === "{") objects.push(new Set());
            else if (token[0] === "[") objects.push(null);
            else if (token[0] === "}" || token[0] === "]") objects.pop();
            else if (/^\s*:/.test(text.slice(token.index + token[0].length))) {
                const key = JSON.parse(token[0]) as string;
                const keys = objects.at(-1);
                if (!keys || keys.has(key)) throw new Error("Unsafe pilot JSON");
                keys.add(key);
            }
        }
        return parsed;
    } finally {
        closeSync(fd);
    }
}

/** Durably replace only the operator-owned policy marker, never overwrite or remove someone else's temporary entry. */
export function writePilotPolicyJson(path: string, value: unknown): void {
    assertPrivatePilotDirectory(dirname(path));
    assertPilotPath(path);
    if (lstatSync(path, { throwIfNoEntry: false })) readPrivatePilotJson(path);
    const temporary = join(dirname(path), ".policy-next");
    const fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
    );
    const identity = fstatSync(fd);
    let renamed = false;
    try {
        writeFileSync(fd, JSON.stringify(value));
        fsyncSync(fd);
        assertPilotPath(path);
        renameSync(temporary, path);
        renamed = true;
        const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
            fsyncSync(directory);
        } finally {
            closeSync(directory);
        }
        if (JSON.stringify(readPrivatePilotJson(path)) !== JSON.stringify(value)) throw new Error("Unsafe pilot JSON");
    } finally {
        closeSync(fd);
        if (!renamed) {
            const current = lstatSync(temporary, { throwIfNoEntry: false });
            if (current?.ino === identity.ino && current.dev === identity.dev) unlinkSync(temporary);
        }
    }
}
