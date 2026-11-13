/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import type { MemoryLab } from "./MemoryLab.ts";
import type { MemoryTurn } from "./memoryTypes.ts";
import type { ExtractiveReader } from "./questionAnsweringTypes.ts";
import type { TextEmbedder } from "./semanticTypes.ts";
import type { EvidenceReading } from "./evidenceReadingTypes.ts";
import { rankSemantic } from "./semanticRetrieval.ts";

/** Read only authorized evidence; omit the encoder only for the separate all-passages control. */
export async function readScopedEvidence(
    lab: MemoryLab,
    turn: MemoryTurn,
    question: string,
    reader: ExtractiveReader,
    encoder?: TextEmbedder,
    limit = 3,
): Promise<EvidenceReading> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid_limit");
    const authorized = lab.search(turn, "");
    const candidates: EvidenceReading["candidates"][number][] = [];
    const ranked = !question.trim()
        ? []
        : encoder
          ? await rankSemantic(lab, turn, question, encoder, limit)
          : authorized.notes.slice(0, limit).map((note) => ({ note, score: null }));
    lab.dispatch(turn, authorized, () => {});
    for (const { note, score } of ranked) {
        lab.dispatch(turn, authorized, () => {});
        const prediction = await reader.read(question, note.text);
        lab.dispatch(turn, authorized, () => {});
        const span = prediction.span;
        const invalidScore =
            [prediction.spanScore, prediction.nullScore, prediction.margin].some((value) => !Number.isFinite(value)) ||
            Math.abs(prediction.margin - (prediction.spanScore - prediction.nullScore)) > 1e-6;
        const invalidSpan =
            span === null
                ? !prediction.unmapped
                : prediction.unmapped ||
                  !span ||
                  !Number.isSafeInteger(span.start) ||
                  !Number.isSafeInteger(span.end) ||
                  span.start < 0 ||
                  span.end <= span.start ||
                  span.end > note.text.length ||
                  span.text !== note.text.slice(span.start, span.end);
        if (invalidScore || invalidSpan) throw new Error("invalid_qa_prediction");
        // A provider may reuse output objects across awaits; retain only a validated immutable snapshot.
        const snapshot = Object.freeze({
            span: span ? Object.freeze({ text: span.text, start: span.start, end: span.end }) : null,
            spanScore: prediction.spanScore,
            nullScore: prediction.nullScore,
            margin: prediction.margin,
            unmapped: prediction.unmapped,
        });
        candidates.push({ note, retrievalScore: score, prediction: snapshot });
    }
    const best = [...candidates].sort((left, right) => right.prediction.margin - left.prediction.margin)[0];
    const span = best?.prediction.span;
    const decision =
        best && span
            ? {
                  state: "answered" as const,
                  answer: {
                      text: span.text,
                      citation: {
                          noteId: best.note.id,
                          scopeId: best.note.scopeId,
                          sourceId: best.note.sourceId,
                          sourceVersion: best.note.sourceVersion,
                          start: span.start,
                          end: span.end,
                      },
                  },
              }
            : { state: best ? ("unmapped_span" as const) : ("no_candidates" as const), answer: null };
    return {
        candidates,
        forced: decision,
        nullAware: best && span && best.prediction.margin <= 0 ? { state: "model_abstain", answer: null } : decision,
    };
}
