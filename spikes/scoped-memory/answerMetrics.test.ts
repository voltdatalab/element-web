/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { expect, it } from "vitest";
import { scoreQuotedAnswer } from "./answerMetrics.ts";

it.each([
    ["-3", "3"],
    ["3%", "3"],
    ["1.5", "1 5"],
    ["2030-12-01", "2030 12 01"],
])("does not erase numeric signs, units or separators: %s / %s", (actual, expected) => {
    expect(scoreQuotedAnswer(actual, expected).exact).toBe(false);
});

it.each(["3 %", "3  %", "3\t\n%", "3\u00a0%", "- 3", "-  3", "-\t\n3", "-\u00a03"])(
    "does not give full credit after dropping whitespace-separated numeric markers: %j",
    (marked) => {
        for (const [actual, expected] of [
            [marked, "3"],
            ["3", marked],
        ]) {
            const result = scoreQuotedAnswer(actual, expected);
            expect(result.exact).toBe(false);
            expect(result.tokenF1).toBeLessThan(1);
        }
    },
);

it("scores NFC, case, punctuation and whitespace without rewriting the quote", () => {
    const actual = "  SAlA\u0303O—azul,\n às 19!  ";
    expect(scoreQuotedAnswer(actual, "salão azul às 19")).toEqual({ exact: true, tokenF1: 1 });
    expect(actual).toBe("  SAlA\u0303O—azul,\n às 19!  ");
});

it.each([
    ["azul azul", "azul", 2 / 3],
    ["azul", "azul azul", 2 / 3],
    ["azul verde", "azul vermelho", 1 / 2],
    ["não aprovado", "aprovado", 2 / 3],
    ["avó", "avo", 0],
    ["19", "20", 0],
    ["", "azul", 0],
    ["azul", "", 0],
    ["?!", "  ", 1],
    ["azul verde", "verde azul", 1],
])("uses token multiplicity and retains accents, numbers and negation: %j / %j", (actual, expected, f1) => {
    const result = scoreQuotedAnswer(actual, expected);
    expect(result.exact).toBe(actual === "?!");
    expect(result.tokenF1).toBeCloseTo(f1);
});
