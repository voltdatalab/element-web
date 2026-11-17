/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    readFileSync,
    lstatSync,
    readdirSync,
    mkdirSync,
    mkdtempSync,
    writeFileSync,
    copyFileSync,
    rmSync,
    realpathSync,
    existsSync,
} from "node:fs";
import { join, dirname, resolve, isAbsolute, extname, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

type PackageRecord = {
    id: string;
    name: string;
    version: string;
    tarballIntegrity: string;
    files: Record<string, string>;
    installerGenerated: { path: string; normalizedSHA512: string }[];
};

function regularFiles(directory: string, prefix = ""): string[] {
    return readdirSync(directory)
        .sort()
        .flatMap((name) => {
            const rel = prefix + name;
            const file = join(directory, name);
            const stat = lstatSync(file);
            if (stat.isDirectory()) return regularFiles(file, rel + "/");
            assert(stat.isFile(), "unexpected non-regular package file");
            return [rel];
        });
}

/** Read package bytes, never package code; only listed installer shims are host-normalized. */
export function inspectPackage(directory: string, expected: PackageRecord, runRoot: string): PackageRecord {
    const names = regularFiles(directory).sort();
    assert.deepEqual(
        names,
        [...Object.keys(expected.files), ...expected.installerGenerated.map((s) => s.path)].sort(),
        "package file names mismatch",
    );
    const files: Record<string, string> = {};
    for (const name of Object.keys(expected.files).sort()) {
        const actual = hash(readFileSync(join(directory, name)));
        assert.equal(actual, expected.files[name], "published file digest mismatch");
        files[name] = actual;
    }
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    assert.equal(manifest.name, expected.name, "package name mismatch");
    assert.equal(manifest.version, expected.version, "package version mismatch");
    const installerGenerated = expected.installerGenerated.map(({ path }) => ({
        path,
        normalizedSHA512: hash(readFileSync(join(directory, path), "utf8").split(runRoot).join("<INSTALL>")),
    }));
    return {
        id: expected.id,
        name: manifest.name,
        version: manifest.version,
        tarballIntegrity: expected.tarballIntegrity,
        files,
        installerGenerated,
    };
}

/** Reject extra/missing/duplicate identities and development-tool families. */
export function verifyIdentities(
    actual: { id: string; name: string; version: string }[],
    expected: { id: string; name: string; version: string }[],
    directDevDependencies: string[],
): void {
    for (const item of actual) {
        assert(
            !directDevDependencies.includes(item.name) &&
                !/^(vitest|oxfmt|typescript|@typescript\/native)$|^@vitest\/|^@typescript\/typescript-/.test(item.name),
            "development package installed",
        );
        assert.equal(item.id, `${item.name}@${item.version}`, "package identity inconsistent");
    }
    assert.deepEqual(actual.map((p) => p.id).sort(), expected.map((p) => p.id).sort(), "package identities mismatch");
    assert.equal(new Set(actual.map((p) => p.id)).size, actual.length, "duplicate identities");
}

/** Audit both NDJSON streams; absence of lifecycle events alone does not prove scripts unnecessary. */
export function auditLogs(text: string): { ignoredScriptsEvents: number; lifecycleEvents: number } {
    let ignoredScriptsEvents = 0;
    for (const line of text.split(/\r?\n/).filter((line) => line.trim())) {
        const event = JSON.parse(line);
        assert(event.name !== "pnpm:lifecycle", "lifecycle event forbidden");
        if (event.name === "pnpm:ignored-scripts") {
            assert.deepEqual(event.packageNames, [], "required scripts blocked; do not enable scripts");
            ignoredScriptsEvents++;
        }
    }
    assert(ignoredScriptsEvents > 0, "missing ignored-scripts evidence");
    return { ignoredScriptsEvents, lifecycleEvents: 0 };
}

/** Compare already normalized inventories without discarding any further differences. */
export function compareInventories(a: unknown, b: unknown): void {
    assert.deepEqual(a, b, "normalized inventories differ");
}

function hash(bytes: string | Buffer, algorithm = "sha512"): string {
    return createHash(algorithm).update(bytes).digest("hex");
}

/** Bind the two regular input files to the independently audited reference. */
export function verifyInputs(directory: string, pins: Record<string, string>): void {
    assert.deepEqual(Object.keys(pins).sort(), ["package.json", "pnpm-lock.yaml"], "input pins");
    for (const [name, expected] of Object.entries(pins)) {
        const file = join(directory, name);
        assert(lstatSync(file).isFile(), "input must be a regular file");
        assert.equal(hash(readFileSync(file), "sha256"), expected, "input digest mismatch");
    }
}

/** Select the supplied tool, without shell, discovery, bootstrap or fallback. */
export function toolCommand(tool: string, args: string[]): { command: string; args: string[] } {
    assert(isAbsolute(tool), "pnpm CLI path must be absolute");
    return [".mjs", ".cjs"].includes(extname(tool))
        ? { command: process.execPath, args: [tool, ...args] }
        : { command: tool, args };
}

/** Construct an allowlist, not a filtered copy of the caller's environment. */
export function isolatedEnvironment(root: string): Record<string, string> {
    return {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_STATE_HOME: join(root, "state"),
        TMPDIR: join(root, "tmp"),
        PNPM_HOME: join(root, "pnpm-home"),
        CI: "true",
        LC_ALL: "C",
        TZ: "UTC",
        npm_config_userconfig: join(root, "user.npmrc"),
        npm_config_globalconfig: join(root, "global.npmrc"),
        npm_config_ignore_scripts: "true",
    };
}

const referenceSHA256 = "81807cd18a673e4829cc5a23f9a8cdf000aa112a1140d671f10008ff8cc7c757";
const directVersions = { "@modelcontextprotocol/sdk": "1.32.2", "express": "5.3.0", "zod": "4.6.7" };
const configFlags = ["--ignore-pnpmfile", "--ignore-workspace", "--config.manage-package-manager-versions=false"];
const installFlags = [
    "--prod",
    "--frozen-lockfile",
    "--ignore-scripts",
    ...configFlags,
    "--registry=https://registry.npmjs.org/",
    "--config.verify-store-integrity=true",
    "--config.side-effects-cache=false",
    "--config.update-notifier=false",
    "--config.fetch-retries=0",
    "--reporter=ndjson",
];

type Reference = {
    inputsSHA256: Record<string, string>;
    nodeVersion: string;
    pnpmVersion: string;
    packages: PackageRecord[];
};

function inside(path: string, directory: string): boolean {
    return path === directory || path.startsWith(directory + sep);
}

function rejectWorkspaceTemp(temp: string, start: string): void {
    let parent = realpathSync(start);
    for (;;) {
        if (existsSync(join(parent, "pnpm-workspace.yaml")) || existsSync(join(parent, ".git"))) {
            assert(!inside(temp, parent), "temporary directory must be outside the monorepo");
        }
        const next = dirname(parent);
        if (next === parent) break;
        parent = next;
    }
}

function runTool(tool: string, args: string[], root: string): { stdout: string; stderr: string } {
    const selected = toolCommand(tool, args);
    const result = spawnSync(selected.command, selected.args, {
        cwd: join(root, "project"),
        env: isolatedEnvironment(root),
        shell: false,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 180_000,
    });
    assert(!result.error && result.status === 0 && !result.signal, "pnpm subprocess failed");
    return { stdout: result.stdout, stderr: result.stderr };
}

function verifyBins(directory: string): number {
    let count = 0;
    for (const name of readdirSync(directory).sort()) {
        const file = join(directory, name);
        if (!lstatSync(file).isDirectory()) continue;
        if (name === ".bin") {
            const bins = readdirSync(file);
            assert(
                !bins.some((bin) => /^(tsc|tsserver|tsgo|vitest|vite|oxfmt)(\.|$)/.test(bin)),
                "development binary installed",
            );
            count += bins.length;
        } else {
            count += verifyBins(file);
        }
    }
    return count;
}

function inspectInstallation(root: string, reference: Reference, devNames: string[]): PackageRecord[] {
    const project = join(root, "project");
    const virtual = join(project, "node_modules/.pnpm");
    const primaries: { directory: string; id: string; name: string; version: string }[] = [];
    const add = (directory: string): void => {
        if (!lstatSync(directory).isDirectory()) return;
        const { name, version } = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
        assert.equal(typeof name, "string", "package name missing");
        assert.equal(typeof version, "string", "package version missing");
        primaries.push({ directory, id: `${name}@${version}`, name, version });
    };
    for (const slot of readdirSync(virtual).sort()) {
        const slotDir = join(virtual, slot);
        if (slot === "node_modules" || !lstatSync(slotDir).isDirectory()) continue;
        const modules = join(slotDir, "node_modules");
        assert(lstatSync(modules).isDirectory(), "virtual store slot missing node_modules");
        for (const name of readdirSync(modules).sort()) {
            if (name === ".bin") continue;
            const entry = join(modules, name);
            if (!lstatSync(entry).isDirectory()) continue;
            if (name.startsWith("@")) {
                for (const scoped of readdirSync(entry).sort()) add(join(entry, scoped));
            } else add(entry);
        }
    }
    verifyIdentities(primaries, reference.packages, devNames);
    verifyBins(join(project, "node_modules"));
    for (const [name, version] of Object.entries(directVersions)) {
        const target = realpathSync(join(project, "node_modules", name));
        const primary = primaries.find((p) => p.name === name && p.version === version);
        assert(primary && target === primary.directory, "direct dependency target mismatch");
    }
    return primaries
        .sort((a, b) => a.id.localeCompare(b.id, "en"))
        .map((primary) => {
            const expected = reference.packages.find((item) => item.id === primary.id);
            assert(expected, "unexpected package");
            return inspectPackage(primary.directory, expected, root);
        });
}

function verifyStore(store: string, packages: PackageRecord[]): number {
    const indexFile = join(store, "v11/index.db");
    assert(lstatSync(indexFile).isFile(), "store index must be regular");
    // This database belongs exclusively to this disposable install, not to the application.
    const db = new DatabaseSync(indexFile, { readOnly: true });
    try {
        const keys = db
            .prepare("SELECT key FROM package_index ORDER BY key")
            .all()
            .map((row) => row.key);
        const expected = packages.map((p) => `${p.tarballIntegrity}\t${p.id}`).sort();
        assert.deepEqual(keys, expected, "store SRI identity keys mismatch");
    } finally {
        db.close();
    }
    const filesRoot = join(store, "v11/files");
    const files = regularFiles(filesRoot);
    assert(files.length > 0, "empty CAS");
    for (const name of files) {
        assert(/^[a-f0-9]{2}\/[a-f0-9]{126}(-exec)?$/.test(name), "unexpected CAS filename");
        const address = name.replace("/", "").replace(/-exec$/, "");
        assert.equal(hash(readFileSync(join(filesRoot, name))), address, "CAS digest mismatch");
    }
    return files.length;
}

function writeJSON(directory: string, name: string, value: unknown): void {
    writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

function main(args: string[]): void {
    const owned: string[] = [];
    let output: string | undefined;
    let phase = "arguments";
    const runs: Record<string, unknown>[] = [];
    let passed = false;
    let pnpmVersion: string | null = null;
    try {
        assert.equal(args.length, 3, "expected source directory, absolute pnpm CLI, NEW output directory");
        const [sourceArg, tool, outputArg] = args;
        phase = "output";
        const candidate = resolve(outputArg);
        mkdirSync(candidate, { mode: 0o700 });
        output = candidate;
        phase = "reference";
        const bytes = readFileSync(new URL("./expected-inventory.json", import.meta.url));
        assert.equal(hash(bytes, "sha256"), referenceSHA256, "reference digest mismatch");
        const reference: Reference = JSON.parse(bytes.toString("utf8"));
        assert.equal(reference.packages.length, 92, "reference identity count");
        phase = "inputs";
        const source = realpathSync(sourceArg);
        verifyInputs(source, reference.inputsSHA256);
        const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
        assert.deepEqual(manifest.dependencies, directVersions, "direct dependency pins mismatch");
        phase = "toolchain";
        assert.equal(process.version, "v22.23.2", "Node version must be exactly v22.23.2");
        assert.equal(reference.nodeVersion, process.version, "reference Node version");
        assert.equal(reference.pnpmVersion, "12.11.2", "reference pnpm version");
        assert(lstatSync(tool).isFile(), "pnpm tool must be an explicit regular file");
        toolCommand(tool, []);
        const temp = realpathSync(tmpdir());
        rejectWorkspaceTemp(temp, source);
        rejectWorkspaceTemp(temp, dirname(fileURLToPath(import.meta.url)));
        const inventories: PackageRecord[][] = [];
        for (const label of ["a", "b"]) {
            phase = `prepare-${label}`;
            const root = mkdtempSync(join(temp, "production-install-"));
            owned.push(root);
            for (const name of ["project", "home", "config", "cache", "data", "state", "tmp", "pnpm-home", "store"]) {
                mkdirSync(join(root, name), { mode: 0o700 });
            }
            for (const name of ["user.npmrc", "global.npmrc"]) writeFileSync(join(root, name), "", { mode: 0o600 });
            for (const name of Object.keys(reference.inputsSHA256))
                copyFileSync(join(source, name), join(root, "project", name));
            const project = join(root, "project");
            verifyInputs(project, reference.inputsSHA256);
            assert.deepEqual(readdirSync(project).sort(), ["package.json", "pnpm-lock.yaml"]);
            phase = `versions-${label}`;
            const node = spawnSync(process.execPath, ["--version"], {
                cwd: project,
                env: isolatedEnvironment(root),
                shell: false,
                encoding: "utf8",
                timeout: 10_000,
            });
            assert.equal(node.status, 0, "Node version probe failed");
            assert.equal(node.stdout.trim(), reference.nodeVersion, "Node executable version mismatch");
            const observedVersion = runTool(tool, ["--version", ...configFlags], root).stdout.trim();
            assert.equal(observedVersion, reference.pnpmVersion, "pnpm executable version mismatch");
            pnpmVersion = observedVersion;
            phase = `install-${label}`;
            const store = join(root, "store");
            const logs = runTool(tool, ["install", ...installFlags, `--store-dir=${store}`], root);
            const scripts = auditLogs(logs.stdout + "\n" + logs.stderr);
            phase = `inventory-${label}`;
            verifyInputs(project, reference.inputsSHA256);
            const inventory = inspectInstallation(root, reference, Object.keys(manifest.devDependencies ?? {}));
            phase = `integrity-${label}`;
            const casFiles = verifyStore(store, inventory);
            phase = `store-status-${label}`;
            runTool(tool, ["store", "status", ...configFlags, `--store-dir=${store}`], root);
            verifyInputs(project, reference.inputsSHA256);
            inventories.push(inventory);
            writeJSON(output, `inventory-${label}.json`, inventory);
            runs.push({
                label,
                packages: inventory.length,
                publishedFiles: inventory.reduce((n, p) => n + Object.keys(p.files).length, 0),
                generatedShims: inventory.reduce((n, p) => n + p.installerGenerated.length, 0),
                casFiles,
                storeStatusExit: 0,
                ...scripts,
                directVersions,
                devToolsAbsent: true,
                inputsUnchanged: true,
            });
        }
        phase = "comparison";
        compareInventories(inventories[0], inventories[1]);
        verifyInputs(source, reference.inputsSHA256);
        passed = true;
    } catch {
        process.exitCode = 1;
    } finally {
        for (const root of owned) {
            try {
                rmSync(root, { recursive: true, force: true });
            } catch {
                passed = false;
                phase = "cleanup";
                process.exitCode = 1;
            }
        }
        if (output) {
            try {
                writeJSON(output, "receipt.json", {
                    schemaVersion: 1,
                    status: passed ? "pass" : "fail",
                    phase: passed ? "complete" : phase,
                    referenceSHA256,
                    nodeVersion: process.version,
                    pnpmVersion,
                    requiredPnpmVersion: "12.11.2",
                    runs,
                    normalizedInventoriesIdentical: passed,
                    ownedDirectoriesCleaned: phase !== "cleanup",
                    installArguments: ["install", ...installFlags, "--store-dir=<STORE>"],
                    environmentKeys: Object.keys(isolatedEnvironment("<INSTALL>")).sort(),
                    scope: "installation-data-only; no installed package imports or runtime compatibility claim",
                    registryControl: "CLI registry and pinned audited inputs; not an OS/network firewall",
                });
            } catch {
                passed = false;
                process.exitCode = 1;
            }
        }
        console[passed ? "log" : "error"](
            passed
                ? "Production installation data verified (two fresh installs)."
                : `Validation failed (${phase}); no scripts or compiler may be enabled to bypass this failure.`,
        );
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
