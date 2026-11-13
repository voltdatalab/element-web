/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import type { TextEmbedder } from "./semanticTypes.ts";
import { MemoryLab } from "./MemoryLab.ts";
import { rankSemantic } from "./semanticRetrieval.ts";
import { fitAbstention, type CalibrationObservation } from "./abstention.ts";

/** Calibrate on independent synthetic passages; no evaluation corpus or labels are accepted here. */
export async function calibrateLocalAbstention(
    encoder: TextEmbedder,
    fixture: {
        name: string;
        passages: readonly string[];
        queries: readonly { id: string; question: string; answerable: boolean }[];
    },
) {
    const lab = new MemoryLab(":memory:");
    try {
        lab.setScope({ id: "calibration", kind: "shared", readers: ["calibrator"], agents: ["encoder"] });
        lab.setConversation({
            id: "calibration",
            audience: ["calibrator"],
            agents: ["encoder"],
            scopes: ["calibration"],
        });
        fixture.passages.forEach((text, index) =>
            lab.addNote({
                id: `calibration-${index}`,
                scopeId: "calibration",
                text,
                sourceId: `calibration-${index}`,
                sourceVersion: 1,
            }),
        );
        const observations: CalibrationObservation[] = [];
        for (const item of fixture.queries) {
            const ranked = await rankSemantic(
                lab,
                lab.beginTurn("calibration", "encoder", "calibrator"),
                item.question,
                encoder,
                1,
            );
            if (!ranked.length) throw new Error("invalid_calibration");
            observations.push({ id: item.id, score: ranked[0].score, answerable: item.answerable });
        }
        return { name: fixture.name, observations, policy: fitAbstention(observations) };
    } finally {
        lab.close();
    }
}
