/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { MemoryLab } from "./MemoryLab.ts";
import { MODEL_CONFIG, openLocalEmbedder } from "./localEmbedding.ts";
import { calibrationFixture } from "./calibrationFixture.ts";
import { calibrateLocalAbstention } from "./calibrateSemantic.ts";
import { retrievalCases, retrievalNotes, seedRetrieval } from "./retrievalFixtures.ts";
import { retrievalStrategies } from "./retrievalStrategies.ts";
import { evaluateRetrieval } from "./retrievalEvaluation.ts";
import { evaluateSemantic } from "./semanticEvaluation.ts";
import type { TextEmbedder } from "./semanticTypes.ts";

assert.equal(process.argv.length, 2, "evaluateSemantic accepts no arguments");
const started = performance.now();
const originalFetch = globalThis.fetch;
let blockedFetchAttempts = 0;
let embeddingCalls = 0;
let embeddedTexts = 0;
let encoder: TextEmbedder | undefined;
const lab = new MemoryLab(":memory:");
// Explicit preparation is a different command. This process must never send source text over HTTP.
globalThis.fetch = async () => {
    blockedFetchAttempts++;
    throw new Error("network_disabled_during_semantic_evaluation");
};
try {
    encoder = await openLocalEmbedder();
    const local = encoder;
    const counted: TextEmbedder = {
        encode: async (texts) => {
            embeddingCalls++;
            embeddedTexts += texts.length;
            return local.encode(texts);
        },
        dispose: () => local.dispose(),
    };
    // Freeze the cutoff on Farol before touching Aurora's evaluation cases.
    const calibration = await calibrateLocalAbstention(counted, calibrationFixture);
    seedRetrieval(lab);
    const baseline = evaluateRetrieval(lab, retrievalNotes, retrievalCases, retrievalStrategies, 3);
    const semantic = await evaluateSemantic(
        lab,
        retrievalNotes,
        retrievalCases,
        counted,
        calibration.policy.threshold,
        3,
    );
    const strategies = [...baseline.strategies, ...semantic.strategies];
    for (const { summary } of strategies) {
        assert.equal(summary.unauthorizedHits, 0);
        assert.equal(summary.staleHits, 0);
        assert.equal(summary.integrityViolations, 0);
        assert.equal(summary.denialMismatches, 0);
        assert.equal(summary.budgetViolations, 0);
    }
    assert.equal(blockedFetchAttempts, 0);
    console.log(
        JSON.stringify(
            {
                status: "COMPLETED_LOCAL_SEMANTIC_RETRIEVAL",
                model: MODEL_CONFIG,
                interpretation:
                    "Synthetic evidence retrieval and heuristic abstention; no generated answers or sufficiency proof",
                calibration,
                evaluation: { ...baseline, strategies },
                semanticDiagnostics: semantic.diagnostics,
                execution: {
                    backend: "onnx_cpu",
                    threads: 1,
                    runtimeDownloads: false,
                    blockedFetchAttempts,
                    embeddingCalls,
                    embeddedTexts,
                    elapsedMs: performance.now() - started,
                    maximumResidentSetKiB: process.resourceUsage().maxRSS,
                },
            },
            null,
            2,
        ),
    );
} finally {
    try {
        await encoder?.dispose();
    } finally {
        lab.close();
        globalThis.fetch = originalFetch;
    }
}
