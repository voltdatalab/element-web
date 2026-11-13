/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import type { MemoryLab } from "./MemoryLab.ts";
import type { MemoryNote, MemoryTurn } from "./memoryTypes.ts";

/** A query contains no answer labels or requested scope overrides. */
export interface RetrievalQuery {
    conversation: string;
    agent: string;
    requester: string;
    question: string;
}

/** Independent ground truth: expectedAnswer is a label, never generated text. */
export interface RetrievalCase extends RetrievalQuery {
    id: string;
    category: "literal" | "question" | "correction" | "permission" | "absent" | "adversarial";
    expectedNoteIds: readonly string[];
    expectedAnswer: string | null;
    allowedScopeIds: readonly string[];
    expectAccessDenied?: boolean;
}

/** Diagnostic retrieval only. Returned notes are not dispatch capabilities or model answers. */
export interface RetrievalStrategy {
    name: string;
    retrieve: (lab: MemoryLab, turn: MemoryTurn, question: string, limit: number) => readonly Readonly<MemoryNote>[];
}
