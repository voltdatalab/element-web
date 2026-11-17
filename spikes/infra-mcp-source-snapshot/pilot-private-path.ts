/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { lstatSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

/** Reject a symlink in any existing component, without repairing the literal path. */
export function assertPilotPath(path: string): void {
    if (
        !isAbsolute(path) ||
        !/^\/[A-Za-z0-9_./-]+$/.test(path) ||
        path
            .slice(1)
            .split("/")
            .some((part) => !part || part === "." || part === "..")
    )
        throw new Error("Unsafe pilot path");
    for (let current = path; ; current = dirname(current)) {
        if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Unsafe pilot path");
        if (current === dirname(current)) break;
    }
}

/** Require an existing owner-only directory. Never chmod or adopt an unsafe directory. */
export function assertPrivatePilotDirectory(path: string): void {
    assertPilotPath(path);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700)
        throw new Error("Unsafe pilot directory");
}

/** Create only the explicit leaf, leaving ancestor ownership and unrelated entries untouched. */
export function ensurePrivatePilotDirectory(path: string): void {
    assertPilotPath(path);
    if (!lstatSync(path, { throwIfNoEntry: false })) mkdirSync(path, { mode: 0o700 });
    assertPrivatePilotDirectory(path);
}
