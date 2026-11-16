/*
Copyright 2026 Volt Data Lab
SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE-AGPL-3.0 in the repository root for full details.
*/

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const { join } = path;
const checker = new URL("./check.mts", import.meta.url);

/** Exercise the CLI on inert bytes, never importing candidate contents. */
test("accepts exact bytes without executing the candidate", () => {
    const base = mkdtempSync(join(tmpdir(), "packaging-test-"));
    try {
        const source = "throw new Error('candidate must never execute');\n";
        writeFileSync(join(base, "source.ts"), source);
        const manifest = `${base}.json`;
        try {
            writeFileSync(
                manifest,
                JSON.stringify({
                    version: 1,
                    profiles: {
                        demo: {
                            "source.ts": createHash("sha256").update(source).digest("hex"),
                        },
                    },
                }),
            );
            const result = spawnSync(process.execPath, [checker.pathname, manifest, "demo", base], {
                encoding: "utf8",
            });
            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(JSON.parse(result.stdout), { status: "FILES_MATCH", files: 1 });
        } finally {
            rmSync(manifest, { force: true });
        }
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});
