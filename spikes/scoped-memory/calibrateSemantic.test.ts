/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { expect, it } from "vitest";
import { calibrateLocalAbstention } from "./calibrateSemantic.ts";
import type { TextEmbedder } from "./semanticTypes.ts";

it("uses a separate calibration database and supplies text, never answerability labels, to the encoder", async () => {
    const calls: (readonly string[])[] = [];
    // Toy vectors validate plumbing only; the CLI measures the pinned real model.
    const encoder: TextEmbedder = {
        encode: async (texts) => {
            calls.push(texts);
            return [[1, 0], texts[0].includes("Presente") ? [0.9, Math.sqrt(0.19)] : [0.8, 0.6]];
        },
        dispose: async () => {},
    };
    const result = await calibrateLocalAbstention(encoder, {
        name: "unit-only",
        passages: ["Texto de calibração."],
        queries: [
            { id: "p", question: "Presente?", answerable: true },
            { id: "n", question: "Ausente?", answerable: false },
        ],
    });
    expect(result.policy.positiveAccepted).toBe(1);
    expect(result.policy.negativeAccepted).toBe(0);
    expect(result.observations).toHaveLength(2);
    expect(calls).toEqual([
        ["query: Presente?", "passage: Texto de calibração."],
        ["query: Ausente?", "passage: Texto de calibração."],
    ]);
});
