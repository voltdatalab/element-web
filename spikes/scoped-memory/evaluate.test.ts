/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("runs the retrieval evaluation without a model and preserves measured misses", () => {
    const script = fileURLToPath(new URL("./evaluate.ts", import.meta.url));
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("COMPLETED_SYNTHETIC_RETRIEVAL");
    expect(report.evaluation).toBe("synthetic_evidence_retrieval_not_answer_quality");
    expect(report.strategies.map((item: { name: string }) => item.name)).toEqual(["literal", "lexical"]);
    for (const strategy of report.strategies) {
        expect(strategy.summary.unauthorizedHits).toBe(0);
        expect(strategy.summary.staleHits).toBe(0);
        expect(strategy.summary.integrityViolations).toBe(0);
        expect(strategy.summary.denialMismatches).toBe(0);
        expect(strategy.summary.budgetViolations).toBe(0);
    }
    expect(report.strategies[0].summary.hitRateAtK).toBeLessThan(1);
});
