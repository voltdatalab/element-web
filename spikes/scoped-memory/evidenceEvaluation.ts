/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import type { MemoryLab } from "./MemoryLab.ts";
import type { MemoryNote, MemoryTurn } from "./memoryTypes.ts";
import type { EvidenceDecision, EvidenceReading } from "./evidenceReadingTypes.ts";
import type { ExtractiveReader } from "./questionAnsweringTypes.ts";
import type { RetrievalCase } from "./retrievalTypes.ts";
import type { TextEmbedder } from "./semanticTypes.ts";
import { scoreQuotedAnswer } from "./answerMetrics.ts";
import { readScopedEvidence } from "./readScopedEvidence.ts";
import { evaluateRetrieval, summarizeRetrievalRows, type RetrievalRow } from "./retrievalEvaluation.ts";

/** Label agreement with audited source identity; neither lexical agreement nor a quote proves semantic support. */
export interface EvidenceEvaluationRow {
    caseId: string;
    question: string;
    category: RetrievalCase["category"];
    expectedAnswer: string | null;
    expectedNoteIds: readonly string[];
    accessDenied: boolean;
    retrievalHit: boolean;
    decision: EvidenceDecision | { state: "access_denied"; answer: null };
    sourceBoundExact: boolean;
    sourceBoundTokenF1: number;
    reading: EvidenceReading | null;
}

function summarize(rows: readonly EvidenceEvaluationRow[]) {
    const positives = rows.filter((row) => row.expectedNoteIds.length > 0);
    const negatives = rows.filter((row) => row.expectedNoteIds.length === 0);
    const evaluatedNegatives = negatives.filter((row) => !row.accessDenied);
    const exactCount = positives.filter((row) => row.sourceBoundExact).length;
    return {
        cases: rows.length,
        positiveCases: positives.length,
        negativeCases: negatives.length,
        evaluatedNegatives: evaluatedNegatives.length,
        deniedCases: rows.filter((row) => row.accessDenied).length,
        negativeAnswers: evaluatedNegatives.filter((row) => row.decision.state === "answered").length,
        recognizedMissingEvidence: evaluatedNegatives.filter((row) => row.decision.state === "model_abstain").length,
        unmappedNegatives: evaluatedNegatives.filter((row) => row.decision.state === "unmapped_span").length,
        noCandidateNegatives: evaluatedNegatives.filter((row) => row.decision.state === "no_candidates").length,
        positiveAnswered: positives.filter((row) => row.decision.state === "answered").length,
        // Unanswered authorized positives include unmapped spans and no candidates, not just model null decisions.
        positiveAbstentions: positives.filter((row) => !row.accessDenied && row.decision.state !== "answered").length,
        sourceBoundExactCount: exactCount,
        // Only positives form the denominator, including unanswered positives with zero credit.
        sourceBoundExactRate: positives.length ? exactCount / positives.length : null,
        meanSourceBoundTokenF1: positives.length
            ? positives.reduce((total, row) => total + row.sourceBoundTokenF1, 0) / positives.length
            : null,
        retrievalHitCases: positives.filter((row) => row.retrievalHit).length,
        retrievalMisses: positives.filter((row) => !row.retrievalHit).length,
    };
}

function byCategory<T extends { category: RetrievalCase["category"] }, Summary>(
    rows: readonly T[],
    aggregate: (selected: readonly T[]) => Summary,
): Record<string, Summary> {
    return Object.fromEntries(
        [...new Set(rows.map((row) => row.category))].map((category) => [
            category,
            aggregate(rows.filter((row) => row.category === category)),
        ]),
    );
}

/** Evaluate extractive policies on arbitrary labeled cases without passing labels to either model. */
export async function evaluateEvidence(
    lab: MemoryLab,
    sources: readonly MemoryNote[],
    cases: readonly RetrievalCase[],
    reader: ExtractiveReader,
    encoder: TextEmbedder | undefined,
    limit = 3,
) {
    const metadata = evaluateRetrieval(lab, sources, cases, [], limit);
    const names = ["extractive_forced", "extractive_null"] as const;
    const rows = new Map(names.map((name) => [name, [] as EvidenceEvaluationRow[]]));
    const retrievalRows: RetrievalRow[] = [];
    const finalGuards: (() => void)[] = [];
    for (const item of cases) {
        let turn: MemoryTurn | undefined;
        try {
            turn = lab.beginTurn(item.conversation, item.agent, item.requester);
        } catch (error) {
            if (!(error instanceof Error) || error.message !== "access_denied" || !item.expectAccessDenied) throw error;
        }
        // Keep the complete authorized snapshot from before inference, including candidates outside K.
        const guardedTurn = turn;
        const snapshot = guardedTurn ? lab.search(guardedTurn, "") : undefined;
        const guard = (): void => {
            if (guardedTurn && snapshot) lab.dispatch(guardedTurn, snapshot, () => {});
        };
        finalGuards.push(guard);
        // The question is explicit: neither cases, labels nor source identifiers enter inference.
        const reading = turn ? await readScopedEvidence(lab, turn, item.question, reader, encoder, limit) : null;
        guard();
        const audited = evaluateRetrieval(
            lab,
            sources,
            [item],
            [
                {
                    name: "evidence_candidates",
                    retrieve: () => {
                        guard();
                        return reading?.candidates.map(({ note }) => note) ?? [];
                    },
                },
            ],
            limit,
        ).strategies[0].rows[0];
        retrievalRows.push(audited);
        for (const name of names) {
            const decision: EvidenceEvaluationRow["decision"] = !reading
                ? { state: "access_denied", answer: null }
                : name === "extractive_forced"
                  ? reading.forced
                  : reading.nullAware;
            const answer = decision.answer;
            const sourceBound =
                !!answer &&
                item.expectedNoteIds.includes(answer.citation.noteId) &&
                !audited.unauthorizedHits &&
                !audited.staleHits &&
                !audited.integrityViolations &&
                !audited.budgetViolation;
            const score =
                sourceBound && item.expectedAnswer !== null
                    ? scoreQuotedAnswer(answer!.text, item.expectedAnswer)
                    : { exact: false, tokenF1: 0 };
            rows.get(name)!.push({
                caseId: item.id,
                question: item.question,
                category: item.category,
                expectedAnswer: item.expectedAnswer,
                expectedNoteIds: [...item.expectedNoteIds],
                accessDenied: audited.accessDenied,
                retrievalHit: audited.relevantHits > 0,
                decision,
                sourceBoundExact: score.exact,
                sourceBoundTokenF1: score.tokenF1,
                reading,
            });
        }
    }
    // A later query may revoke an earlier conversation or supersede any of its observed sources.
    for (const guard of finalGuards) guard();
    return {
        ...metadata,
        evaluation: "synthetic_extractive_label_proxy_not_semantic_proof",
        strategies: names.map((name) => {
            const all = rows.get(name)!;
            return { name, summary: summarize(all), byCategory: byCategory(all, summarize), rows: all };
        }),
        retrieval: {
            summary: summarizeRetrievalRows(retrievalRows, limit),
            byCategory: byCategory(retrievalRows, (selected) => summarizeRetrievalRows(selected, limit)),
            rows: retrievalRows,
        },
    };
}
