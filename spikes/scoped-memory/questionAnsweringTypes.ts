/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

/** Literal source span; offsets refer to the original JavaScript string, not decoded tokens. */
export interface ExtractedSpan {
    text: string;
    start: number;
    end: number;
}

/** Raw extractive prediction. A positive margin is a model decision, not a proof of factual support. */
export interface ExtractivePrediction {
    span: ExtractedSpan | null;
    spanScore: number;
    nullScore: number;
    margin: number;
    unmapped: boolean;
}

/** Stateless local question/context reader; never receives labels, source identifiers or permissions. */
export interface ExtractiveReader {
    read: (question: string, context: string) => Promise<ExtractivePrediction>;
    dispose: () => Promise<void>;
}
