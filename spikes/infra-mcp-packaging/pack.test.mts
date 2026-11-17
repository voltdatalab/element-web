/*
Copyright 2026 Volt Data Lab
SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE-AGPL-3.0 in the repository root for full details.
*/

import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
    existsSync,
} from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(here, "candidate-files.json");
const profiles: Record<string, Record<string, string>> = JSON.parse(readFileSync(manifestPath, "utf8")).profiles;
const names = [...new Set(Object.values(profiles).flatMap(Object.keys))].sort();
const snapshot = path.join(here, "../infra-mcp-source-snapshot");

function hash(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function fixture(body: (root: string, corpus: string) => void): void {
    assert.ok(process.env.TMPDIR, "TMPDIR must designate the profile scratch directory");
    const root = mkdtempSync(path.join(process.env.TMPDIR, "pack-test-"));
    try {
        const corpus = path.join(root, "corpus");
        mkdirSync(corpus);
        for (const name of names) writeFileSync(path.join(corpus, name), readFileSync(path.join(snapshot, name)));
        body(root, corpus);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function pack(corpus: string, output: string): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, [path.join(here, "pack.mts"), corpus, output], {
        encoding: "utf8",
        timeout: 30000,
    });
}

test("should reject a required symlink even when its target bytes match", () => {
    fixture((root, corpus) => {
        const name = names[0];
        rmSync(path.join(corpus, name));
        symlinkSync(path.join(snapshot, name), path.join(corpus, name));
        const output = path.join(root, "output");
        const result = pack(corpus, output);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /PACKAGES_REJECTED/);
        assert.equal(existsSync(output), false);
    });
});

test("should reject a symlink corpus root", () => {
    fixture((root, corpus) => {
        const alias = path.join(root, "alias");
        symlinkSync(corpus, alias);
        const output = path.join(root, "output");
        assert.equal(pack(alias, output).status, 1);
        assert.equal(pack(`${alias}/`, output).status, 1);
        assert.equal(existsSync(output), false);
    });
});

for (const mutation of ["missing", "corrupt", "directory", "oversized"] as const) {
    test(`should reject ${mutation} required bytes without publishing output`, () => {
        fixture((root, corpus) => {
            const filename = path.join(corpus, names[0]);
            rmSync(filename);
            if (mutation === "corrupt") writeFileSync(filename, "throw new Error('INERT_SOURCE_SENTINEL');\n");
            if (mutation === "directory") mkdirSync(filename);
            if (mutation === "oversized") writeFileSync(filename, Buffer.alloc(16777217));
            const output = path.join(root, "output");
            const result = pack(corpus, output);
            assert.equal(result.status, 1, result.stderr);
            assert.equal(result.stderr.trim(), "PACKAGES_REJECTED");
            assert.equal(existsSync(output), false);
        });
    });
}

test("should preserve a pre-existing output directory and its bytes", () => {
    fixture((root, corpus) => {
        const output = path.join(root, "output");
        mkdirSync(output);
        writeFileSync(path.join(output, "candidate-backend.tar"), "owned sentinel");
        const result = pack(corpus, output);
        assert.equal(result.status, 1);
        assert.deepEqual(readdirSync(output), ["candidate-backend.tar"]);
        assert.equal(readFileSync(path.join(output, "candidate-backend.tar"), "utf8"), "owned sentinel");
    });
});

test("should preserve pre-existing file and dangling symlink outputs", () => {
    fixture((root, corpus) => {
        const output = path.join(root, "output");
        writeFileSync(output, "owned file");
        assert.equal(pack(corpus, output).status, 1);
        assert.equal(readFileSync(output, "utf8"), "owned file");
        rmSync(output);
        const target = path.join(root, "absent");
        symlinkSync(target, output);
        assert.equal(pack(corpus, output).status, 1);
        assert.equal(existsSync(target), false);
    });
});

test("should ignore synthetic source, test, context, database and invalid-name extras without reading them", () => {
    fixture((root, corpus) => {
        for (const name of ["extra.ts", "extra.test.ts", "context.json", "state.sqlite", "bad\nname.ts", "--option"]) {
            writeFileSync(path.join(corpus, name), "throw new Error('EXTRA_MUST_NOT_EXECUTE');\n");
        }
        symlinkSync(path.join(root, "absent"), path.join(corpus, "unread-extra.ts"));
        mkdirSync(path.join(corpus, "nested"));
        const output = path.join(root, "output");
        assert.equal(pack(corpus, output).status, 0);
        for (const [profile, files] of Object.entries(profiles)) {
            const archive = path.join(output, `candidate-${profile}.tar`);
            assert.deepEqual(tar(["-tf", archive]).toString().trimEnd().split("\n"), Object.keys(files).sort());
        }
    });
});

test("should reject incorrect CLI arity", () => {
    const result = spawnSync(process.execPath, [path.join(here, "pack.mts")], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), "PACKAGES_REJECTED");
});

function tar(args: string[]): Buffer {
    const result = spawnSync("tar", args, { timeout: 10000, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr?.toString());
    return result.stdout;
}

test("should produce byte-identical flat regular source archives checked from their actual members", () => {
    fixture((root, corpus) => {
        const outputs = [path.join(root, "first"), path.join(root, "second")];
        for (const output of outputs) {
            const result = pack(corpus, output);
            assert.equal(result.status, 0, result.stderr);
            for (const name of names) {
                chmodSync(path.join(corpus, name), 0o700);
                utimesSync(path.join(corpus, name), 123456789, 987654321);
            }
        }
        const expectedOutput = ["SHA256SUMS", ...Object.keys(profiles).map((p) => `candidate-${p}.tar`)].sort();
        assert.deepEqual(readdirSync(outputs[0]).sort(), expectedOutput);
        const sums: string[] = [];
        for (const [profile, files] of Object.entries(profiles)) {
            const filename = `candidate-${profile}.tar`;
            const archive = path.join(outputs[0], filename);
            assert.deepEqual(readFileSync(archive), readFileSync(path.join(outputs[1], filename)));
            sums.push(`${hash(readFileSync(archive))}  ${filename}\n`);
            const members = Object.keys(files).sort();
            assert.deepEqual(tar(["-tf", archive]).toString().trimEnd().split("\n"), members);
            const verbose = tar(["--numeric-owner", "--full-time", "-tvf", archive]).toString().trimEnd().split("\n");
            for (const line of verbose) assert.match(line, /^-rw-r--r-- 0\/0\s+\d+ 1970-01-01 00:00:00 /);
            const extracted = path.join(root, profile);
            mkdirSync(extracted);
            for (const name of members) {
                assert.match(name, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
                const bytes = tar(["-xOf", archive, "--", name]);
                assert.equal(hash(bytes), files[name], name);
                writeFileSync(path.join(extracted, name), bytes, { flag: "wx" });
            }
            for (const license of ["LICENSE-AGPL-3.0", "LICENSE-COMMERCIAL", "LICENSE-GPL-3.0"]) {
                assert.equal(hash(readFileSync(path.join(extracted, license))), files[license]);
            }
            const checked = spawnSync(
                process.execPath,
                [path.join(here, "check.mts"), manifestPath, profile, extracted],
                {
                    encoding: "utf8",
                },
            );
            assert.equal(checked.status, 0, checked.stderr);
            assert.deepEqual(JSON.parse(checked.stdout), { status: "FILES_MATCH", files: members.length });
        }
        assert.equal(readFileSync(path.join(outputs[0], "SHA256SUMS"), "utf8"), sums.sort().join(""));
        assert.deepEqual(
            readFileSync(path.join(outputs[0], "SHA256SUMS")),
            readFileSync(path.join(outputs[1], "SHA256SUMS")),
        );
    });
});
