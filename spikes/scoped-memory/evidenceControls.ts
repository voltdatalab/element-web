/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import type { ExtractiveReader } from "./questionAnsweringTypes.ts";
import type { EvidenceReading } from "./evidenceReadingTypes.ts";
import { MemoryLab } from "./MemoryLab.ts";
import { calibrationFixture } from "./calibrationFixture.ts";
import { readScopedEvidence } from "./readScopedEvidence.ts";

/** Independent synthetic controls observe a fixed null-margin rule, without fitting a new cutoff. */
export async function runEvidenceControls(reader: ExtractiveReader) {
    const lab = new MemoryLab(":memory:");
    try {
        lab.setScope({ id: "control", kind: "shared", readers: ["observer"], agents: ["reader"] });
        lab.setConversation({ id: "control", audience: ["observer"], agents: ["reader"], scopes: ["control"] });
        calibrationFixture.passages.forEach((text, index) =>
            lab.addNote({
                id: `control-${index}`,
                scopeId: "control",
                sourceId: `control-${index}`,
                sourceVersion: 1,
                text,
            }),
        );
        const rows: { id: string; question: string; answerable: boolean; reading: EvidenceReading }[] = [];
        const guards: (() => void)[] = [];
        for (const query of calibrationFixture.queries) {
            const turn = lab.beginTurn("control", "reader", "observer");
            const snapshot = lab.search(turn, "");
            guards.push(() => lab.dispatch(turn, snapshot, () => {}));
            // All four passages, without a retriever, isolate the reader's null decision.
            const reading = await readScopedEvidence(
                lab,
                turn,
                query.question,
                reader,
                undefined,
                calibrationFixture.passages.length,
            );
            rows.push({ id: query.id, question: query.question, answerable: query.answerable, reading });
        }
        for (const guard of guards) guard();
        return {
            name: calibrationFixture.name,
            interpretation:
                "Fixed rule controls, not calibration; accepted positives do not establish answer correctness",
            rule: "best_span_minus_null_strictly_positive",
            strategies: (["forced", "nullAware"] as const).map((policy) => ({
                name: policy,
                summary: {
                    answerableCases: rows.filter((row) => row.answerable).length,
                    negativeCases: rows.filter((row) => !row.answerable).length,
                    positiveAccepted: rows.filter((row) => row.answerable && row.reading[policy].answer).length,
                    negativeAnswers: rows.filter((row) => !row.answerable && row.reading[policy].answer).length,
                    recognizedMissingEvidence: rows.filter(
                        (row) => !row.answerable && row.reading[policy].state === "model_abstain",
                    ).length,
                    unmappedNegatives: rows.filter(
                        (row) => !row.answerable && row.reading[policy].state === "unmapped_span",
                    ).length,
                },
            })),
            rows,
        };
    } finally {
        lab.close();
    }
}
