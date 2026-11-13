/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import type { MemoryNote } from "./memoryTypes.ts";
import type { ExtractivePrediction } from "./questionAnsweringTypes.ts";

/** A literal quote with metadata supplied by the authorized source, never by the model. */
export interface CitedAnswer {
    text: string;
    citation: { noteId: string; scopeId: string; sourceId: string; sourceVersion: number; start: number; end: number };
}

/** Diagnostic decision, not a MemoryLab dispatch capability or proof of factual support. */
export interface EvidenceDecision {
    state: "answered" | "model_abstain" | "unmapped_span" | "no_candidates";
    answer: CitedAnswer | null;
}

/** Both policies use the same predictions. Null-aware acceptance requires a strictly positive margin. */
export interface EvidenceReading {
    candidates: readonly {
        note: Readonly<MemoryNote>;
        retrievalScore: number | null;
        prediction: ExtractivePrediction;
    }[];
    forced: EvidenceDecision;
    nullAware: EvidenceDecision;
}
