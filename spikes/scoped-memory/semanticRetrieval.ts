/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import type { MemoryLab } from "./MemoryLab.ts";
import type { MemoryNote, MemoryTurn } from "./memoryTypes.ts";
import type { TextEmbedder } from "./semanticTypes.ts";

/** A similarity score is a ranking signal, not proof that a note answers a question. */
export interface SemanticCandidate {
    note: Readonly<MemoryNote>;
    score: number;
}

/** Rank only the authorized current view, with another authorization check after inference. */
export async function rankSemantic(
    lab: MemoryLab,
    turn: MemoryTurn,
    question: string,
    encoder: TextEmbedder,
    limit: number,
): Promise<readonly SemanticCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid_limit");
    const authorized = lab.search(turn, "");
    if (!question.trim() || !authorized.notes.length) return [];
    const vectors = await encoder.encode([
        `query: ${question}`,
        ...authorized.notes.map((note) => `passage: ${note.text}`),
    ]);
    // The local encoder is stateless, but grants and sources may change across its await.
    lab.dispatch(turn, authorized, () => {});
    const query = vectors[0];
    if (
        vectors.length !== authorized.notes.length + 1 ||
        !query?.length ||
        vectors.some(
            (vector) =>
                vector.length !== query.length ||
                vector.some((value) => !Number.isFinite(value)) ||
                !Number.isFinite(Math.hypot(...vector)) ||
                Math.hypot(...vector) === 0,
        )
    ) {
        throw new Error("invalid_embedding");
    }
    const score = (vector: readonly number[]): number => {
        const dot = query.reduce((sum, value, index) => sum + value * vector[index], 0);
        const value = dot / (Math.hypot(...query) * Math.hypot(...vector));
        if (!Number.isFinite(value)) throw new Error("invalid_embedding");
        return Math.max(-1, Math.min(1, value));
    };
    return authorized.notes
        .map((note, index) => ({ note, score: score(vectors[index + 1]) }))
        .sort((left, right) => right.score - left.score || left.note.id.localeCompare(right.note.id))
        .slice(0, limit);
}
