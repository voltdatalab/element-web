/*
Copyright 2026 Volt Data Lab
SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE-AGPL-3.0 in the repository root for full details.
*/

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(here, "candidate-files.json");

/** Copy bytes only after rejecting links and non-regular files without blocking on FIFOs. */
function sourceBytes(filename: string): Buffer {
    const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 16777216) throw new Error("source type or size");
        return readFileSync(fd);
    } finally {
        closeSync(fd);
    }
}

function hash(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function command(program: string, args: string[], cwd?: string): Buffer {
    const result = spawnSync(program, args, {
        cwd,
        env: { PATH: process.env.PATH, LC_ALL: "C", TZ: "UTC" },
        timeout: 30000,
        maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error("command failed");
    return result.stdout;
}

let temporary: string | undefined;
try {
    const [corpusArgument, output] = process.argv.slice(2);
    if (process.argv.length !== 4 || !process.env.TMPDIR) throw new Error("usage");
    const corpus = path.resolve(corpusArgument);
    const corpusStat = lstatSync(corpus);
    if (!corpusStat.isDirectory() || corpusStat.isSymbolicLink()) throw new Error("corpus root");
    const profiles: Record<string, Record<string, string>> = JSON.parse(readFileSync(manifestPath, "utf8")).profiles;
    temporary = mkdtempSync(path.join(process.env.TMPDIR, "source-pack-"));
    const artifacts = path.join(temporary, "artifacts");
    mkdirSync(artifacts);
    const sums: string[] = [];
    for (const [profile, files] of Object.entries(profiles)) {
        const stage = path.join(temporary, profile);
        mkdirSync(stage);
        const names = Object.keys(files).sort();
        for (const name of names) writeFileSync(path.join(stage, name), sourceBytes(path.join(corpus, name)));
        command(process.execPath, [path.join(here, "check.mts"), manifestPath, profile, stage]);
        const filename = `candidate-${profile}.tar`;
        const archive = path.join(artifacts, filename);
        command(
            "tar",
            [
                "--format=ustar",
                "--mtime=@0",
                "--owner=0",
                "--group=0",
                "--numeric-owner",
                "--mode=0644",
                "--no-recursion",
                "-cf",
                archive,
                "--",
                ...names,
            ],
            stage,
        );
        const listed = command("tar", ["-tf", archive]).toString().trimEnd().split("\n");
        if (JSON.stringify(listed) !== JSON.stringify(names)) throw new Error("members");
        const verbose = command("tar", ["--numeric-owner", "--full-time", "-tvf", archive])
            .toString()
            .trimEnd()
            .split("\n");
        if (verbose.some((line) => !/^-rw-r--r-- 0\/0\s+\d+ 1970-01-01 00:00:00 /.test(line)))
            throw new Error("metadata");
        for (const name of names) {
            if (hash(command("tar", ["-xOf", archive, "--", name])) !== files[name]) throw new Error("member hash");
        }
        sums.push(`${hash(readFileSync(archive))}  ${filename}\n`);
    }
    writeFileSync(path.join(artifacts, "SHA256SUMS"), sums.sort().join(""));
    mkdirSync(output);
    for (const filename of ["SHA256SUMS", ...Object.keys(profiles).map((p) => `candidate-${p}.tar`)]) {
        writeFileSync(path.join(output, filename), readFileSync(path.join(artifacts, filename)), { flag: "wx" });
    }
    console.log("PACKAGES_MATCH");
} catch {
    console.error("PACKAGES_REJECTED");
    process.exitCode = 1;
} finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
}
