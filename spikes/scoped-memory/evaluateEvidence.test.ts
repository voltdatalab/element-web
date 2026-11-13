/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(new URL("./evaluateEvidence.ts", import.meta.url));
it("rejects arguments before loading any model or opening a database", () => {
    const result = spawnSync(process.execPath, [script, "unexpected"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("evaluateEvidence accepts no arguments");
    expect(result.stdout).toBe("");
});

it.runIf(process.env.ELEMENT_AGENTS_EVIDENCE_INTEGRATION === "1")(
    "runs real local extraction with explicit null decisions",
    () => {
        const result = spawnSync(process.execPath, [script], {
            encoding: "utf8",
            timeout: 180000,
            maxBuffer: 6 * 1024 * 1024,
        });
        expect(result.status, result.stderr).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.status).toBe("COMPLETED_LOCAL_EXTRACTIVE_EVIDENCE");
        expect(report.protocol.nullMarginThreshold).toBe(0);
        expect(report.execution.readerCalls).toBeGreaterThan(0);
        expect(report.execution.blockedFetchAttempts).toBe(0);
        expect(report.controls.rows).toHaveLength(8);
        expect(report.evaluation.strategies).toHaveLength(2);
        expect(report.evaluation.retrieval.summary).toMatchObject({
            cases: 24,
            answerableCases: 16,
            deniedCases: 1,
            unauthorizedHits: 0,
            staleHits: 0,
            integrityViolations: 0,
            denialMismatches: 0,
            budgetViolations: 0,
        });
    },
    190000,
);
