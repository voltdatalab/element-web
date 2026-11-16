/*
Copyright 2026 Volt Data Lab
SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE-AGPL-3.0 in the repository root for full details.
*/

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const { join } = path;
const checker = new URL("./check.mts", import.meta.url);
const invalidCases = [
    "extra-file",
    "missing-file",
    "changed-bytes",
    "extra-directory",
    "symlink-file",
    "symlink-root",
    "path-traversal",
    "absolute-path",
    "empty-profile",
    "bad-hash",
    "unknown-version",
    "extra-schema-key",
    "rejected-adapter",
    "private-state",
    "test-fixture",
    "malformed-json",
    "unknown-profile",
    "extra-cli-argument",
] as const;

for (const scenario of invalidCases) {
    test(`rejects ${scenario} without reporting success`, () => {
        const base = mkdtempSync(join(tmpdir(), "packaging-negative-"));
        try {
            const root = join(base, "candidate");
            mkdirSync(root);
            const source = "inert bytes";
            const digest = createHash("sha256").update(source).digest("hex");
            const files: Record<string, string> = { "source.ts": digest };
            const manifest: Record<string, unknown> = { version: 1, profiles: { demo: files } };
            writeFileSync(join(root, "source.ts"), source);
            let selectedRoot = root;
            let profile = "demo";
            if (scenario === "extra-file") writeFileSync(join(root, "extra.ts"), source);
            if (scenario === "missing-file") rmSync(join(root, "source.ts"));
            if (scenario === "changed-bytes") writeFileSync(join(root, "source.ts"), "different");
            if (scenario === "extra-directory") mkdirSync(join(root, "extra"));
            if (scenario === "symlink-file") {
                rmSync(join(root, "source.ts"));
                writeFileSync(join(base, "outside.ts"), source);
                symlinkSync(join(base, "outside.ts"), join(root, "source.ts"));
            }
            if (scenario === "symlink-root") {
                selectedRoot = join(base, "alias");
                symlinkSync(root, selectedRoot);
            }
            if (scenario === "path-traversal" || scenario === "absolute-path") {
                writeFileSync(join(base, "outside.ts"), source);
                const path = scenario === "path-traversal" ? "../outside.ts" : join(base, "outside.ts");
                delete files["source.ts"];
                files[path] = digest;
            }
            if (scenario === "empty-profile") delete files["source.ts"];
            if (scenario === "bad-hash") files["source.ts"] = "not-a-sha256";
            if (scenario === "unknown-version") manifest.version = 2;
            if (scenario === "extra-schema-key") manifest.run = "must never run";
            for (const [kind, name] of [
                ["rejected-adapter", "CapRoverRuntimeReader.ts"],
                ["private-state", "state.sqlite"],
                ["test-fixture", "source.test.ts"],
            ]) {
                if (scenario === kind) {
                    files[name] = digest;
                    writeFileSync(join(root, name), source);
                }
            }
            if (scenario === "unknown-profile") profile = "unknown";
            const path = join(base, "manifest.json");
            writeFileSync(path, scenario === "malformed-json" ? "{" : JSON.stringify(manifest));
            const args = [checker.pathname, path, profile, selectedRoot];
            if (scenario === "extra-cli-argument") args.push("extra");
            const result = spawnSync(process.execPath, args, { encoding: "utf8" });
            assert.equal(result.status, 1);
            assert.equal(result.stdout, "");
            assert.equal(result.stderr, "FILES_REJECTED\n");
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });
}
