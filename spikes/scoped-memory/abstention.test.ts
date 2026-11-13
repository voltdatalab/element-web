/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { expect, it } from "vitest";
import { fitAbstention } from "./abstention.ts";

it("sets the smallest conservative cutoff above calibration negatives, without evaluation labels", () => {
    const fit = fitAbstention([
        { id: "positive", score: 0.9, answerable: true },
        { id: "negative", score: 0.8, answerable: false },
    ]);
    expect(fit.threshold).toBeGreaterThan(0.8);
    expect(fit.threshold).toBeLessThanOrEqual(0.9);
    expect(fit.positiveAccepted).toBe(1);
    expect(fit.negativeAccepted).toBe(0);
});

it.each([
    { observations: [] },
    { observations: [{ id: "only", score: 0.8, answerable: true }] },
    { observations: [{ id: "only", score: 0.8, answerable: false }] },
    {
        observations: [
            { id: "a", score: Number.NaN, answerable: true },
            { id: "b", score: 0.8, answerable: false },
        ],
    },
    {
        observations: [
            { id: "a", score: 2, answerable: true },
            { id: "b", score: 0.8, answerable: false },
        ],
    },
    {
        observations: [
            { id: "a", score: 0.9, answerable: true },
            { id: "a", score: 0.8, answerable: false },
        ],
    },
])("rejects invalid calibration instead of publishing a non-finite or unsupported policy", ({ observations }) => {
    expect(() => fitAbstention(observations)).toThrow("invalid_calibration");
});

it("can reject every positive when calibration classes overlap; does not tune on evaluation cases", () => {
    const fit = fitAbstention([
        { id: "p", score: 1, answerable: true },
        { id: "n", score: 1, answerable: false },
    ]);
    expect(fit.threshold).toBeGreaterThan(1);
    expect(fit.positiveAccepted).toBe(0);
    expect(fit.negativeAccepted).toBe(0);
});
