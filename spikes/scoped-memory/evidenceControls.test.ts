/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { expect, it } from "vitest";
import { runEvidenceControls } from "./evidenceControls.ts";
import type { ExtractiveReader } from "./questionAnsweringTypes.ts";

it.each([0, -1])("counts unquotable control negatives separately from missing evidence: %j", async (margin) => {
    const reader: ExtractiveReader = {
        read: async () => ({ span: null, spanScore: margin, nullScore: 0, margin, unmapped: true }),
        dispose: async () => {},
    };
    const report = await runEvidenceControls(reader);
    for (const strategy of report.strategies) {
        expect(strategy.summary).toMatchObject({
            answerableCases: 4,
            negativeCases: 4,
            positiveAccepted: 0,
            negativeAnswers: 0,
            recognizedMissingEvidence: 0,
            unmappedNegatives: 4,
        });
    }
    for (const row of report.rows) {
        expect(row.reading.forced).toEqual({ state: "unmapped_span", answer: null });
        expect(row.reading.nullAware).toEqual({ state: "unmapped_span", answer: null });
    }
});

it("measures the independent Farol control without treating accepted positives as verified answers", async () => {
    const calls: string[][] = [];
    // This intentionally over-accepting toy reader tests the report, not semantic quality.
    const reader: ExtractiveReader = {
        read: async (question, context) => {
            calls.push([question, context]);
            return {
                span: { text: context, start: 0, end: context.length },
                spanScore: 1,
                nullScore: 0,
                margin: 1,
                unmapped: false,
            };
        },
        dispose: async () => {},
    };
    const report = await runEvidenceControls(reader);
    expect(report.rows).toHaveLength(8);
    expect(calls).toHaveLength(32);
    expect(JSON.stringify(calls)).not.toContain("answerable");
    for (const strategy of report.strategies) {
        expect(strategy.summary).toMatchObject({
            answerableCases: 4,
            negativeCases: 4,
            positiveAccepted: 4,
            negativeAnswers: 4,
        });
    }
});
