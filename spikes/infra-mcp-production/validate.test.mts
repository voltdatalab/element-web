/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as validator from "./validate.mts";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./validate.mts", import.meta.url));

test("should select only the explicit CLI path and isolate subprocess environment", () => {
    assert.equal(typeof validator.toolCommand, "function", "missing tool selector");
    assert.deepEqual(validator.toolCommand("/explicit/pnpm.mjs", ["--version"]), {
        command: process.execPath,
        args: ["/explicit/pnpm.mjs", "--version"],
    });
    assert.deepEqual(validator.toolCommand("/explicit/pnpm.cjs", ["--version"]), {
        command: process.execPath,
        args: ["/explicit/pnpm.cjs", "--version"],
    });
    assert.deepEqual(validator.toolCommand("/explicit/pnpm", ["--version"]), {
        command: "/explicit/pnpm",
        args: ["--version"],
    });
    assert.throws(() => validator.toolCommand("pnpm", []), /absolute/);
    process.env.PRODUCTION_TEST_SECRET = "must-not-inherit";
    try {
        const env = validator.isolatedEnvironment("/owned");
        assert.equal(env.PRODUCTION_TEST_SECRET, undefined);
        assert.equal(env.NODE_OPTIONS, undefined);
        assert.equal(env.HOME, "/owned/home");
        assert.equal(env.npm_config_ignore_scripts, "true");
    } finally {
        delete process.env.PRODUCTION_TEST_SECRET;
    }
});

test("should fail closed on bad inputs and never overwrite an existing output", () => {
    fixture((root) => {
        const source = join(root, "source");
        mkdirSync(source);
        writeFileSync(join(source, "package.json"), "{}");
        writeFileSync(join(source, "pnpm-lock.yaml"), "wrong");
        const output = join(root, "new-output");
        const result = spawnSync(process.execPath, [cli, source, "/unused/pnpm.mjs", output], { encoding: "utf8" });
        assert.equal(result.status, 1, "CLI must reject changed inputs before spawning the tool");
        const receipt = JSON.parse(readFileSync(join(output, "receipt.json"), "utf8"));
        assert.equal(receipt.status, "fail");
        assert.equal(receipt.phase, "inputs");
        assert.equal(receipt.pnpmVersion, null, "an unexecuted tool must not be reported as observed");
        const before = readFileSync(join(output, "receipt.json"), "utf8");
        const repeated = spawnSync(process.execPath, [cli, source, "/unused/pnpm.mjs", output], { encoding: "utf8" });
        assert.equal(repeated.status, 1);
        assert.equal(readFileSync(join(output, "receipt.json"), "utf8"), before);
    });
});

const digest = (text: string, algorithm = "sha512"): string => createHash(algorithm).update(text).digest("hex");

test("should reject unexpected identities, direct dev dependencies and compiler families", () => {
    assert.equal(typeof validator.verifyIdentities, "function", "missing identity verifier");
    const reference = [{ id: "safe@1", name: "safe", version: "1" }];
    validator.verifyIdentities(reference, reference, ["dev-only"]);
    assert.throws(() => validator.verifyIdentities([], reference, []), /identities/);
    for (const name of [
        "dev-only",
        "vitest",
        "oxfmt",
        "typescript",
        "@typescript/native",
        "@vitest/runner",
        "@typescript/typescript-linux-x64",
    ]) {
        const forbidden = [{ id: `${name}@1`, name, version: "1" }];
        assert.throws(() => validator.verifyIdentities(forbidden, forbidden, ["dev-only"]), /development/);
    }
    assert.throws(() => validator.verifyIdentities([...reference, ...reference], reference, []), /identities/);
});

test("should reject lifecycle or ignored required scripts and compare normalized inventories exactly", () => {
    assert.equal(typeof validator.auditLogs, "function", "missing log verifier");
    assert.equal(typeof validator.compareInventories, "function", "missing inventory comparison");
    assert.equal(validator.auditLogs('{"name":"pnpm:ignored-scripts","packageNames":[]}\n').ignoredScriptsEvents, 1);
    assert.throws(() => validator.auditLogs('{"name":"pnpm:lifecycle"}'), /lifecycle/);
    assert.throws(
        () => validator.auditLogs('{"name":"pnpm:ignored-scripts","packageNames":["needs-build"]}'),
        /scripts/,
    );
    assert.throws(() => validator.auditLogs(""), /ignored-scripts/);
    assert.throws(() => validator.auditLogs("not-json"));
    validator.compareInventories([{ wrapper: "same" }], [{ wrapper: "same" }]);
    assert.throws(() => validator.compareInventories([{ wrapper: "same" }], [{ wrapper: "changed" }]), /inventories/);
});

test("should compare real wrapper fixtures across roots and keep other differences visible", () => {
    fixture((rootA) =>
        fixture((rootB) => {
            const manifest = '{"name":"fixture","version":"1"}';
            const expected = {
                id: "fixture@1",
                name: "fixture",
                version: "1",
                tarballIntegrity: "sha512-fixture",
                files: { "package.json": digest(manifest) },
                installerGenerated: [{ path: "shim", normalizedSHA512: "ignored-host-pin" }],
            };
            for (const root of [rootA, rootB]) {
                writeFileSync(join(root, "package.json"), manifest);
                writeFileSync(join(root, "shim"), `${root}/node /stable/external/path`);
            }
            const a = validator.inspectPackage(rootA, expected, rootA);
            const b = validator.inspectPackage(rootB, expected, rootB);
            validator.compareInventories(a, b);
            assert.throws(() => validator.inspectPackage(rootA, { ...expected, name: "wrong-name" }, rootA), /name/);
            writeFileSync(join(rootB, "shim"), `${rootB}/node /changed/external/path`);
            assert.throws(
                () => validator.compareInventories(a, validator.inspectPackage(rootB, expected, rootB)),
                /inventories/,
            );
        }),
    );
});

function fixture(action: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "production-unit-"));
    try {
        action(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

test("should bind both exact input files and reject changed or missing inputs", () => {
    assert.equal(typeof validator.verifyInputs, "function", "missing input verifier");
    fixture((root) => {
        writeFileSync(join(root, "package.json"), "{}");
        writeFileSync(join(root, "pnpm-lock.yaml"), "lock");
        const pins = { "package.json": digest("{}", "sha256"), "pnpm-lock.yaml": digest("lock", "sha256") };
        validator.verifyInputs(root, pins);
        writeFileSync(join(root, "pnpm-lock.yaml"), "changed");
        assert.throws(() => validator.verifyInputs(root, pins), /input/);
        rmSync(join(root, "pnpm-lock.yaml"));
        assert.throws(() => validator.verifyInputs(root, pins));
    });
});

test("should verify exact published files and normalize only installer-owned wrapper paths", () => {
    assert.equal(typeof validator.inspectPackage, "function", "missing package verifier");
    fixture((root) => {
        const expected = {
            id: "example@1.0.0",
            name: "example",
            version: "1.0.0",
            tarballIntegrity: "sha512-example",
            files: { "package.json": digest('{"name":"example","version":"1.0.0"}') },
            installerGenerated: [{ path: "node_modules/.bin/node-which", normalizedSHA512: "not-a-host-pin" }],
        };
        writeFileSync(join(root, "package.json"), '{"name":"example","version":"1.0.0"}');
        mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
        const wrapper = join(root, "node_modules/.bin/node-which");
        writeFileSync(wrapper, `#! /bin/sh\n${root}/node /different/path`);
        const inventory = validator.inspectPackage(root, expected, root);
        assert.equal(
            inventory.installerGenerated[0].normalizedSHA512,
            digest("#! /bin/sh\n<INSTALL>/node /different/path"),
        );
        writeFileSync(join(root, "extra"), "unexpected");
        assert.throws(() => validator.inspectPackage(root, expected, root), /file names/);
        rmSync(join(root, "extra"));
        writeFileSync(join(root, "package.json"), "corrupt");
        assert.throws(() => validator.inspectPackage(root, expected, root), /digest/);
        rmSync(join(root, "package.json"));
        assert.throws(() => validator.inspectPackage(root, expected, root), /file names/);
    });
});
