/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { TextEmbedder } from "./semanticTypes.ts";
import type { ExtractiveReader } from "./questionAnsweringTypes.ts";

assert.equal(process.argv.length, 2, "evaluateEvidence accepts no arguments");
const started = performance.now();
const originalFetch = globalThis.fetch;
let blockedFetchAttempts = 0;
let embeddingCalls = 0;
let embeddedTexts = 0;
let readerCalls = 0;
let encoder: TextEmbedder | undefined;
let reader: ExtractiveReader | undefined;
globalThis.fetch = async () => {
    blockedFetchAttempts++;
    throw new Error("network_disabled_during_evidence_evaluation");
};
try {
    const { MemoryLab } = await import("./MemoryLab.ts");
    const { MODEL_CONFIG, openLocalEmbedder } = await import("./localEmbedding.ts");
    const { QA_MODEL_CONFIG, openLocalQuestionAnswerer } = await import("./localQuestionAnswering.ts");
    const { retrievalCases, retrievalNotes, seedRetrieval } = await import("./retrievalFixtures.ts");
    const { evaluateEvidence } = await import("./evidenceEvaluation.ts");
    const { runEvidenceControls } = await import("./evidenceControls.ts");
    encoder = await openLocalEmbedder();
    reader = await openLocalQuestionAnswerer();
    const localEncoder = encoder;
    const localReader = reader;
    const countedEncoder: TextEmbedder = {
        encode: async (texts) => {
            embeddingCalls++;
            embeddedTexts += texts.length;
            return localEncoder.encode(texts);
        },
        dispose: () => localEncoder.dispose(),
    };
    const countedReader: ExtractiveReader = {
        read: async (question, context) => {
            readerCalls++;
            return localReader.read(question, context);
        },
        dispose: () => localReader.dispose(),
    };
    // Farol observes the pretrained zero-margin criterion; it never fits a new threshold.
    const controls = await runEvidenceControls(countedReader);
    const lab = new MemoryLab(":memory:");
    try {
        seedRetrieval(lab);
        const evaluation = await evaluateEvidence(
            lab,
            retrievalNotes,
            retrievalCases,
            countedReader,
            countedEncoder,
            3,
        );
        const summary = evaluation.retrieval.summary;
        for (const key of [
            "unauthorizedHits",
            "staleHits",
            "integrityViolations",
            "denialMismatches",
            "budgetViolations",
        ] as const) {
            assert.equal(summary[key], 0);
        }
        const superseded = new Set(retrievalNotes.flatMap((note) => (note.supersedes ? [note.supersedes] : [])));
        for (const strategy of evaluation.strategies) {
            for (const row of strategy.rows) {
                const answer = row.decision.answer;
                if (!answer) continue;
                const source = retrievalNotes.find((note) => note.id === answer.citation.noteId);
                const query = retrievalCases.find((item) => item.id === row.caseId);
                assert(source && query);
                assert(query.allowedScopeIds.includes(source.scopeId));
                assert(!superseded.has(source.id));
                assert.equal(answer.citation.scopeId, source.scopeId);
                assert.equal(answer.citation.sourceId, source.sourceId);
                assert.equal(answer.citation.sourceVersion, source.sourceVersion);
                assert.equal(answer.text, source.text.slice(answer.citation.start, answer.citation.end));
            }
        }
        assert.equal(blockedFetchAttempts, 0);
        console.log(
            JSON.stringify(
                {
                    status: "COMPLETED_LOCAL_EXTRACTIVE_EVIDENCE",
                    interpretation:
                        "Synthetic source-bound extractive answers and null decisions, not factual entailment certification",
                    protocol: {
                        maxCandidates: 3,
                        maxSpanTokens: 32,
                        nullMarginThreshold: 0,
                        selection: "maximum_span_minus_null_logit_sum",
                        calibration: "none",
                        answerForm: "literal_source_quote",
                        generation: false,
                    },
                    models: { retrieval: MODEL_CONFIG, reader: QA_MODEL_CONFIG },
                    controls,
                    evaluation,
                    execution: {
                        backend: "onnx_cpu",
                        threadsPerModel: 1,
                        runtimeDownloads: false,
                        blockedFetchAttempts,
                        embeddingCalls,
                        embeddedTexts,
                        readerCalls,
                        elapsedMs: performance.now() - started,
                        maximumResidentSetKiB: process.resourceUsage().maxRSS,
                    },
                },
                null,
                2,
            ),
        );
    } finally {
        lab.close();
    }
} finally {
    try {
        await reader?.dispose();
    } finally {
        try {
            await encoder?.dispose();
        } finally {
            globalThis.fetch = originalFetch;
        }
    }
}
