/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

describe("demo CLI", () => {
    it("rejects arguments before loading or starting the experiment", () => {
        const result = spawnSync(
            process.execPath,
            [fileURLToPath(new URL("./run.ts", import.meta.url)), "unexpected"],
            { encoding: "utf8", timeout: 10000 },
        );
        expect(result.status).toBe(1);
        expect(result.stderr.trim()).toBe("unexpected_arguments");
        expect(result.stdout).toBe("");
    });
});
