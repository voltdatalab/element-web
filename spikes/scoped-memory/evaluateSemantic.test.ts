/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(new URL("./evaluateSemantic.ts", import.meta.url));
it("rejects CLI arguments before opening a model or any database", () => {
    const result = spawnSync(process.execPath, [script, "unexpected"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("evaluateSemantic accepts no arguments");
    expect(result.stdout).toBe("");
});

it.runIf(process.env.ELEMENT_AGENTS_SEMANTIC_INTEGRATION === "1")(
    "runs the pinned real model offline with explicit preparation",
    () => {
        const result = spawnSync(process.execPath, [script], {
            encoding: "utf8",
            timeout: 120000,
            maxBuffer: 4 * 1024 * 1024,
        });
        expect(result.status, result.stderr).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.status).toBe("COMPLETED_LOCAL_SEMANTIC_RETRIEVAL");
        expect(report.model.dimensions).toBe(384);
        expect(report.execution.embeddingCalls).toBeGreaterThan(0);
        expect(report.execution.blockedFetchAttempts).toBe(0);
        expect(report.evaluation.strategies).toHaveLength(4);
        expect(report.calibration.observations).toHaveLength(8);
        for (const strategy of report.evaluation.strategies) {
            expect(strategy.summary).toMatchObject({
                cases: 24,
                answerableCases: 16,
                unauthorizedHits: 0,
                staleHits: 0,
                integrityViolations: 0,
                denialMismatches: 0,
                budgetViolations: 0,
            });
        }
    },
    130000,
);
