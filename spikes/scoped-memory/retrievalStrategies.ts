/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import type { RetrievalStrategy } from "./retrievalTypes.ts";

const stopWords = new Set([
    "a",
    "as",
    "o",
    "os",
    "de",
    "do",
    "da",
    "dos",
    "das",
    "e",
    "um",
    "uma",
    "para",
    "por",
    "com",
    "no",
    "na",
    "nos",
    "nas",
    "em",
    "que",
    "qual",
    "quais",
    "como",
    "quem",
    "quando",
    "foi",
]);

function terms(text: string): Set<string> {
    const normalized = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    return new Set((normalized.match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => !stopWords.has(word)));
}

function validateLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid_limit");
}

/** Diagnostic baselines operate only on notes exposed by the scoped memory service. */
export const retrievalStrategies: readonly RetrievalStrategy[] = [
    {
        name: "literal",
        retrieve: (lab, turn, question, limit) => {
            validateLimit(limit);
            const authorized = lab.search(turn, question);
            return question.trim() ? authorized.notes.slice(0, limit) : [];
        },
    },
    {
        name: "lexical",
        retrieve: (lab, turn, question, limit) => {
            validateLimit(limit);
            // Document frequencies are computed only inside the authorized view, never over private partitions.
            const documents = lab.search(turn, "").notes.map((note) => ({ note, terms: terms(note.text) }));
            const words = terms(question);
            const weights = new Map(
                [...words].map((word) => [
                    word,
                    1 + Math.log((documents.length + 1) / (documents.filter((doc) => doc.terms.has(word)).length + 1)),
                ]),
            );
            return documents
                .map(({ note, terms: present }) => ({
                    note,
                    score: [...words].reduce((total, word) => total + (present.has(word) ? weights.get(word)! : 0), 0),
                }))
                .filter((item) => item.score > 0)
                .sort(
                    (left, right) =>
                        right.score - left.score ||
                        (left.note.id < right.note.id ? -1 : left.note.id > right.note.id ? 1 : 0),
                )
                .slice(0, limit)
                .map((item) => item.note);
        },
    },
];
