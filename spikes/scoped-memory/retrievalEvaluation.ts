/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import type { MemoryLab } from "./MemoryLab.ts";
import type { MemoryNote, MemoryTurn } from "./memoryTypes.ts";
import type { RetrievalCase, RetrievalStrategy } from "./retrievalTypes.ts";

/** One observed retrieval compared with labels that were never supplied to the strategy. */
export interface RetrievalRow {
    caseId: string;
    category: RetrievalCase["category"];
    question: string;
    expectedAnswer: string | null;
    expectedNoteIds: readonly string[];
    retrieved: readonly Readonly<MemoryNote>[];
    state: "hit" | "miss" | "negative_empty" | "negative_candidates" | "denied";
    relevantHits: number;
    accessDenied: boolean;
    denialMismatch: boolean;
    unauthorizedHits: number;
    staleHits: number;
    integrityViolations: number;
    budgetViolation: boolean;
}

/** Aggregate already-audited rows, keeping the same @K rules for synchronous and local-model runs. */
export function summarizeRetrievalRows(rows: readonly RetrievalRow[], limit: number) {
    const positives = rows.filter((row) => row.expectedNoteIds.length > 0);
    const negatives = rows.filter((row) => row.expectedNoteIds.length === 0);
    const hits = positives.filter((row) => row.relevantHits > 0).length;
    const sum = (select: (row: RetrievalRow) => number) => rows.reduce((total, row) => total + select(row), 0);
    return {
        cases: rows.length,
        answerableCases: positives.length,
        hitCases: hits,
        hitRateAtK: positives.length ? hits / positives.length : null,
        meanRecallAtK: positives.length
            ? positives.reduce((total, row) => total + row.relevantHits / row.expectedNoteIds.length, 0) /
              positives.length
            : null,
        meanPrecisionAtK: positives.length
            ? positives.reduce(
                  (total, row) =>
                      total + (row.retrieved.length ? row.relevantHits / Math.min(row.retrieved.length, limit) : 0),
                  0,
              ) / positives.length
            : null,
        negativeCases: negatives.length,
        negativeCasesWithCandidates: negatives.filter((row) => row.retrieved.length > 0).length,
        deniedCases: rows.filter((row) => row.accessDenied).length,
        denialMismatches: sum((row) => Number(row.denialMismatch)),
        unauthorizedHits: sum((row) => row.unauthorizedHits),
        staleHits: sum((row) => row.staleHits),
        integrityViolations: sum((row) => row.integrityViolations),
        budgetViolations: sum((row) => Number(row.budgetViolation)),
    };
}

function sameSource(actual: Readonly<MemoryNote>, expected: Readonly<MemoryNote> | undefined): boolean {
    return (
        !!expected &&
        actual.scopeId === expected.scopeId &&
        actual.text === expected.text &&
        actual.sourceId === expected.sourceId &&
        actual.sourceVersion === expected.sourceVersion &&
        (actual.supersedes ?? null) === (expected.supersedes ?? null) &&
        JSON.stringify(actual.parents ?? []) === JSON.stringify(expected.parents ?? [])
    );
}

/** Evaluate evidence retrieval, not generated answers, semantic correctness or token savings. */
export function evaluateRetrieval(
    lab: MemoryLab,
    sources: readonly MemoryNote[],
    cases: readonly RetrievalCase[],
    strategies: readonly RetrievalStrategy[],
    limit = 3,
) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid_limit");
    const canonical = new Map(sources.map((note) => [note.id, note]));
    const superseded = new Set(sources.flatMap((note) => (note.supersedes ? [note.supersedes] : [])));
    if (
        canonical.size !== sources.length ||
        new Set(cases.map((item) => item.id)).size !== cases.length ||
        new Set(strategies.map((item) => item.name)).size !== strategies.length
    )
        throw new Error("invalid_dataset");
    for (const item of cases) {
        if (
            new Set(item.expectedNoteIds).size !== item.expectedNoteIds.length ||
            item.expectedNoteIds.some(
                (id) =>
                    !canonical.has(id) ||
                    superseded.has(id) ||
                    !item.allowedScopeIds.includes(canonical.get(id)!.scopeId),
            )
        )
            throw new Error("invalid_dataset");
    }
    return {
        schemaVersion: 1,
        evaluation: "synthetic_evidence_retrieval_not_answer_quality",
        limit,
        sourceRecords: sources.length,
        currentSourceRecords: sources.filter((note) => !superseded.has(note.id)).length,
        cases: cases.length,
        strategies: strategies.map((strategy) => {
            const rows: RetrievalRow[] = cases.map((item) => {
                let retrieved: readonly Readonly<MemoryNote>[] = [];
                let accessDenied = false;
                let turn: MemoryTurn | undefined;
                try {
                    turn = lab.beginTurn(item.conversation, item.agent, item.requester);
                } catch (error) {
                    if (!(error instanceof Error) || error.message !== "access_denied") throw error;
                    accessDenied = true;
                }
                // The retriever receives only the question, scoped turn and common limit, never the answer key.
                if (turn) retrieved = strategy.retrieve(lab, turn, item.question, limit);
                const seen = new Set<string>();
                const valid = new Set<string>();
                let unauthorizedHits = 0;
                let staleHits = 0;
                let integrityViolations = 0;
                // Audit every returned candidate, but credit evidence only within the first K positions.
                for (const [index, note] of retrieved.entries()) {
                    const original = canonical.get(note.id);
                    const unauthorized = !item.allowedScopeIds.includes(original?.scopeId ?? note.scopeId);
                    const stale = superseded.has(note.id);
                    const corrupt = !sameSource(note, original) || seen.has(note.id);
                    unauthorizedHits += Number(unauthorized);
                    staleHits += Number(stale);
                    integrityViolations += Number(corrupt);
                    if (index < limit && !unauthorized && !stale && !corrupt) valid.add(note.id);
                    seen.add(note.id);
                }
                const relevantHits = item.expectedNoteIds.filter((id) => valid.has(id)).length;
                const state = accessDenied
                    ? "denied"
                    : item.expectedNoteIds.length
                      ? relevantHits
                          ? "hit"
                          : "miss"
                      : retrieved.length
                        ? "negative_candidates"
                        : "negative_empty";
                return {
                    caseId: item.id,
                    category: item.category,
                    question: item.question,
                    expectedAnswer: item.expectedAnswer,
                    expectedNoteIds: item.expectedNoteIds,
                    retrieved,
                    state,
                    relevantHits,
                    accessDenied,
                    denialMismatch: accessDenied !== (item.expectAccessDenied ?? false),
                    unauthorizedHits,
                    staleHits,
                    integrityViolations,
                    budgetViolation: retrieved.length > limit,
                };
            });
            return {
                name: strategy.name,
                summary: summarizeRetrievalRows(rows, limit),
                byCategory: Object.fromEntries(
                    [...new Set(rows.map((row) => row.category))].map((category) => [
                        category,
                        summarizeRetrievalRows(
                            rows.filter((row) => row.category === category),
                            limit,
                        ),
                    ]),
                ),
                rows,
            };
        }),
    };
}
