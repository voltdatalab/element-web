/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("runs the offline demo as a new process and reports actual assertion results", () => {
    const script = fileURLToPath(new URL("./run.ts", import.meta.url));
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("PASS_OFFLINE_SYNTHETIC");
    expect(report.seededNotes).toBe(24);
    expect(report.accessCases).toBe(32);
    expect(report.checks).toContain("revocation_before_handoff");
    expect(report.checks).toContain("source_correction");
});
