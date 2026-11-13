/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import type { MemoryLab } from "./MemoryLab.ts";
import type { MemoryNote, MemoryTurn } from "./memoryTypes.ts";
import type { RetrievalCase } from "./retrievalTypes.ts";
import type { TextEmbedder } from "./semanticTypes.ts";
import { evaluateRetrieval, summarizeRetrievalRows, type RetrievalRow } from "./retrievalEvaluation.ts";
import { rankSemantic, type SemanticCandidate } from "./semanticRetrieval.ts";

/** Evaluate local semantic candidates and a fixed abstention policy on identical authorized inputs. */
export async function evaluateSemantic(
    lab: MemoryLab,
    sources: readonly MemoryNote[],
    cases: readonly RetrievalCase[],
    encoder: TextEmbedder,
    threshold: number,
    limit = 3,
) {
    if (!Number.isFinite(threshold)) throw new Error("invalid_threshold");
    const metadata = evaluateRetrieval(lab, sources, cases, [], limit);
    const names = ["semantic_local", "semantic_local_abstain"];
    const rows = new Map(names.map((name) => [name, [] as RetrievalRow[]]));
    const diagnostics: { caseId: string; candidates: { noteId: string; score: number }[] }[] = [];
    const finalGuards: (() => void)[] = [];
    for (const item of cases) {
        let turn: MemoryTurn | undefined;
        try {
            turn = lab.beginTurn(item.conversation, item.agent, item.requester);
        } catch (error) {
            if (!(error instanceof Error) || error.message !== "access_denied") throw error;
        }
        let candidates: readonly SemanticCandidate[] = [];
        if (turn) candidates = await rankSemantic(lab, turn, item.question, encoder, limit);
        diagnostics.push({
            caseId: item.id,
            candidates: candidates.map(({ note, score }) => ({ noteId: note.id, score })),
        });
        // Each closure belongs to this query's authorized view; there is no cross-conversation vector index.
        const guardedTurn = turn;
        const snapshot = guardedTurn ? lab.search(guardedTurn, "") : undefined;
        const guard = (): void => {
            if (guardedTurn && snapshot) lab.dispatch(guardedTurn, snapshot, () => {});
        };
        finalGuards.push(guard);
        const one = evaluateRetrieval(
            lab,
            sources,
            [item],
            names.map((name) => ({
                name,
                retrieve: (currentLab, currentTurn) => {
                    guard();
                    const current = currentLab.search(currentTurn, "").notes;
                    const selected = candidates.filter(
                        (candidate) => name === "semantic_local" || candidate.score >= threshold,
                    );
                    return selected.map(({ note }) => {
                        const fresh = current.find((entry) => entry.id === note.id && entry.scopeId === note.scopeId);
                        if (!fresh) throw new Error("access_revoked");
                        return fresh;
                    });
                },
            })),
            limit,
        );
        for (const strategy of one.strategies) rows.get(strategy.name)!.push(...strategy.rows);
    }
    // Recheck earlier queries after later awaits, before exposing the consolidated report.
    for (const guard of finalGuards) guard();
    return {
        ...metadata,
        threshold,
        diagnostics,
        strategies: names.map((name) => {
            const all = rows.get(name)!;
            const negatives = all.filter((row) => !row.expectedNoteIds.length && !row.accessDenied);
            return {
                name,
                summary: summarizeRetrievalRows(all, limit),
                byCategory: Object.fromEntries(
                    [...new Set(all.map((row) => row.category))].map((category) => [
                        category,
                        summarizeRetrievalRows(
                            all.filter((row) => row.category === category),
                            limit,
                        ),
                    ]),
                ),
                abstention: {
                    evaluatedNegatives: negatives.length,
                    correctAbstentions: negatives.filter((row) => !row.retrieved.length).length,
                    negativeAccepted: negatives.filter((row) => row.retrieved.length > 0).length,
                    falseAbstentions: all.filter((row) => row.expectedNoteIds.length > 0 && !row.retrieved.length)
                        .length,
                },
                rows: all,
            };
        }),
    };
}
