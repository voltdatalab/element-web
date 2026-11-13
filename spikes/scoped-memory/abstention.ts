/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

/** Synthetic calibration observations; never pass these labels to the encoder or retriever. */
export interface CalibrationObservation {
    id: string;
    score: number;
    answerable: boolean;
}

/** A heuristic cutoff, not a probability or proof that an answer is supported. */
export function fitAbstention(observations: readonly CalibrationObservation[]): {
    rule: string;
    threshold: number;
    positiveAccepted: number;
    negativeAccepted: number;
    positiveCount: number;
    negativeCount: number;
} {
    const positives = observations.filter((item) => item.answerable);
    const negatives = observations.filter((item) => !item.answerable);
    if (
        !positives.length ||
        !negatives.length ||
        new Set(observations.map((item) => item.id)).size !== observations.length ||
        observations.some((item) => !item.id || !Number.isFinite(item.score) || item.score < -1 || item.score > 1)
    ) {
        throw new Error("invalid_calibration");
    }
    const threshold = Math.max(...negatives.map((item) => item.score)) + 1e-6;
    return {
        rule: "maximum_calibration_negative_plus_1e-6",
        threshold,
        positiveAccepted: positives.filter((item) => item.score >= threshold).length,
        negativeAccepted: negatives.filter((item) => item.score >= threshold).length,
        positiveCount: positives.length,
        negativeCount: negatives.length,
    };
}
