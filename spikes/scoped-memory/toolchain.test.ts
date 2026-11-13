/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("uses the lockfile-pinned compiler without falling back to a global tsc", () => {
    const metadata = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    expect(metadata.devDependencies.typescript).toBe("6.0.3");
    expect(metadata.scripts.check).toBe("node node_modules/typescript/bin/tsc --noEmit");
    const compiler = fileURLToPath(new URL("./node_modules/typescript/bin/tsc", import.meta.url));
    const result = spawnSync(process.execPath, [compiler, "--version"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("Version 6.0.3");
});
