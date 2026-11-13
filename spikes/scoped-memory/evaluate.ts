/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import assert from "node:assert/strict";
import { MemoryLab } from "./MemoryLab.ts";
import { retrievalCases, retrievalNotes, seedRetrieval } from "./retrievalFixtures.ts";
import { evaluateRetrieval } from "./retrievalEvaluation.ts";
import { retrievalStrategies } from "./retrievalStrategies.ts";

assert.equal(process.argv.length, 2, "This evaluation accepts no arguments or database paths");
const lab = new MemoryLab(":memory:");
try {
    seedRetrieval(lab);
    const report = evaluateRetrieval(lab, retrievalNotes, retrievalCases, retrievalStrategies, 3);
    for (const { summary } of report.strategies) {
        // These are safety/integrity gates, not a requirement to find every answer.
        assert.equal(summary.unauthorizedHits, 0);
        assert.equal(summary.staleHits, 0);
        assert.equal(summary.integrityViolations, 0);
        assert.equal(summary.denialMismatches, 0);
        assert.equal(summary.budgetViolations, 0);
    }
    console.log(JSON.stringify({ status: "COMPLETED_SYNTHETIC_RETRIEVAL", ...report }, null, 2));
} finally {
    lab.close();
}
