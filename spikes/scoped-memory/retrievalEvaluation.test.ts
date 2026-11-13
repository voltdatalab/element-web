/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, expect, it } from "vitest";
import { MemoryLab } from "./MemoryLab.ts";
import { evaluateRetrieval } from "./retrievalEvaluation.ts";
import { retrievalStrategies } from "./retrievalStrategies.ts";
import type { MemoryNote } from "./memoryTypes.ts";
import type { RetrievalCase } from "./retrievalTypes.ts";

const notes: MemoryNote[] = [
    { id: "deadline", scopeId: "team", text: "prazo terça-feira", sourceId: "ata", sourceVersion: 1 },
    { id: "private", scopeId: "private", text: "CANARIO_PRIVADO", sourceId: "dm", sourceVersion: 1 },
];
const base = { conversation: "room", agent: "a", requester: "owner", allowedScopeIds: ["team"] };
const cases: RetrievalCase[] = [
    {
        ...base,
        id: "hit",
        category: "literal",
        question: "prazo",
        expectedNoteIds: ["deadline"],
        expectedAnswer: "terça-feira",
    },
    {
        ...base,
        id: "miss",
        category: "question",
        question: "calendário",
        expectedNoteIds: ["deadline"],
        expectedAnswer: "terça-feira",
    },
    { ...base, id: "empty", category: "absent", question: "zzzz", expectedNoteIds: [], expectedAnswer: null },
];
let lab: MemoryLab;
beforeEach(() => {
    lab = new MemoryLab(":memory:");
    lab.setScope({ id: "team", kind: "shared", readers: ["owner", "peer"], agents: ["a"] });
    lab.setScope({ id: "private", kind: "dm", conversationId: "dm", readers: ["owner"], agents: ["a"] });
    lab.setConversation({ id: "room", audience: ["owner", "peer"], agents: ["a"], scopes: ["team", "private"] });
    for (const note of notes) lab.addNote(note);
});
afterEach(() => lab.close());

it("measures real hits and misses instead of treating a benchmark as a perfect-answer test", () => {
    const report = evaluateRetrieval(lab, notes, cases, [retrievalStrategies[0]], 3);
    const summary = report.strategies[0].summary;
    expect(summary.cases).toBe(3);
    expect(summary.answerableCases).toBe(2);
    expect(summary.hitCases).toBe(1);
    expect(summary.hitRateAtK).toBe(0.5);
    expect(summary.meanRecallAtK).toBe(0.5);
    expect(summary.meanPrecisionAtK).toBe(0.5);
    expect(summary.negativeCasesWithCandidates).toBe(0);
    expect(summary.unauthorizedHits).toBe(0);
    expect(report.strategies[0].rows[0].expectedAnswer).toBe("terça-feira");
    expect(report.strategies[0].rows[1].state).toBe("miss");
});

it("does not pass answer keys or case metadata to a retriever", () => {
    const calls: unknown[][] = [];
    const strategy = {
        name: "observer",
        retrieve: (...args: Parameters<(typeof retrievalStrategies)[number]["retrieve"]>) => {
            calls.push(args);
            return [];
        },
    };
    const changed = [{ ...cases[0], expectedAnswer: "LABEL_ONLY_NEVER_A_QUERY" }];
    evaluateRetrieval(lab, notes, changed, [strategy], 3);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(4);
    expect(calls[0][2]).toBe("prazo");
    expect(JSON.stringify(calls[0].slice(2))).not.toContain("LABEL_ONLY_NEVER_A_QUERY");
});

it("counts irrelevant negative candidates separately from unauthorized disclosure", () => {
    const negative = [{ ...cases[2], question: "prazo" }];
    const report = evaluateRetrieval(lab, notes, negative, [retrievalStrategies[0]], 3);
    expect(report.strategies[0].summary.negativeCasesWithCandidates).toBe(1);
    expect(report.strategies[0].summary.unauthorizedHits).toBe(0);
    expect(report.strategies[0].summary.hitRateAtK).toBeNull();
    expect(report.strategies[0].rows[0].state).toBe("negative_candidates");
});

it("detects an unsafe strategy and refuses to credit its evidence", () => {
    const report = evaluateRetrieval(lab, notes, [cases[0]], [{ name: "unsafe", retrieve: () => [notes[1]] }], 3);
    expect(report.strategies[0].summary.unauthorizedHits).toBe(1);
    expect(report.strategies[0].summary.hitCases).toBe(0);
});

it("detects forged source text and duplicate evidence instead of inflating precision", () => {
    const forged = evaluateRetrieval(
        lab,
        notes,
        [cases[0]],
        [
            { name: "forged", retrieve: () => [{ ...notes[0], text: "made up" }] },
            { name: "duplicate", retrieve: () => [notes[0], notes[0]] },
        ],
        3,
    );
    expect(forged.strategies[0].summary.integrityViolations).toBe(1);
    expect(forged.strategies[0].summary.hitCases).toBe(0);
    expect(forged.strategies[1].summary.integrityViolations).toBe(1);
    expect(forged.strategies[1].summary.meanPrecisionAtK).toBe(0.5);
});

it("detects stale evidence even when it comes from an allowed scope", () => {
    const correction = {
        ...notes[0],
        id: "updated",
        text: "prazo sexta-feira",
        sourceVersion: 2,
        supersedes: "deadline",
    };
    lab.addNote(correction);
    const updatedCase = { ...cases[0], expectedNoteIds: ["updated"], expectedAnswer: "sexta-feira" };
    const report = evaluateRetrieval(
        lab,
        [...notes, correction],
        [updatedCase],
        [{ name: "stale", retrieve: () => [notes[0]] }],
        3,
    );
    expect(report.strategies[0].summary.staleHits).toBe(1);
    expect(report.strategies[0].summary.hitCases).toBe(0);
});

it("does not credit the expected source at K+1 when selection exceeds the budget", () => {
    const irrelevant = ["agenda", "budget", "location"].map((id) => ({
        id,
        scopeId: "team",
        text: id,
        sourceId: id,
        sourceVersion: 1,
    }));
    for (const note of irrelevant) lab.addNote(note);
    const retrieved = [...irrelevant, notes[0]];
    const report = evaluateRetrieval(
        lab,
        [...notes, ...irrelevant],
        [cases[0]],
        [{ name: "over-budget", retrieve: () => retrieved }],
        3,
    );
    const result = report.strategies[0];
    expect(result.summary.budgetViolations).toBe(1);
    expect(result.summary).toMatchObject({
        hitCases: 0,
        hitRateAtK: 0,
        meanRecallAtK: 0,
        meanPrecisionAtK: 0,
    });
    expect(result.byCategory.literal).toEqual(result.summary);
    expect(result.rows[0].relevantHits).toBe(0);
    expect(result.rows[0].state).toBe("miss");
    expect(result.rows[0].retrieved).toEqual(retrieved);
    expect(result.rows[0].retrieved).toHaveLength(4);
});

it("uses only the first K candidates as the precision denominator when an extra tail is returned", () => {
    const irrelevant = ["agenda", "budget", "location"].map((id) => ({
        id,
        scopeId: "team",
        text: id,
        sourceId: id,
        sourceVersion: 1,
    }));
    for (const note of irrelevant) lab.addNote(note);
    const retrieved = [notes[0], ...irrelevant];
    const report = evaluateRetrieval(
        lab,
        [...notes, ...irrelevant],
        [cases[0]],
        [{ name: "over-budget", retrieve: () => retrieved }],
        3,
    );
    const result = report.strategies[0];
    expect(result.summary.budgetViolations).toBe(1);
    expect(result.summary.meanPrecisionAtK).toBe(1 / 3);
    expect(result.summary.hitRateAtK).toBe(1);
    expect(result.summary.meanRecallAtK).toBe(1);
    expect(result.byCategory.literal).toEqual(result.summary);
    expect(result.rows[0].relevantHits).toBe(1);
    expect(result.rows[0].state).toBe("hit");
    expect(result.rows[0].retrieved).toEqual(retrieved);
    expect(result.rows[0].retrieved).toHaveLength(4);
});

it("audits authorization, provenance, staleness and duplicates in the tail beyond K", () => {
    const irrelevant = { id: "agenda", scopeId: "team", text: "agenda", sourceId: "agenda", sourceVersion: 1 };
    const forgedSource = { ...irrelevant, id: "provenance", sourceId: "provenance" };
    const stale = { id: "old", scopeId: "team", text: "old", sourceId: "versioned", sourceVersion: 1 };
    const current = { ...stale, id: "current", text: "current", sourceVersion: 2, supersedes: stale.id };
    for (const note of [irrelevant, forgedSource, stale, current]) lab.addNote(note);
    const retrieved = [notes[0], current, irrelevant, notes[1], { ...forgedSource, text: "made up" }, stale, notes[0]];
    const report = evaluateRetrieval(
        lab,
        [...notes, irrelevant, forgedSource, stale, current],
        [cases[0]],
        [{ name: "unsafe-tail", retrieve: () => retrieved }],
        3,
    );
    const result = report.strategies[0];
    expect(result.summary).toMatchObject({
        unauthorizedHits: 1,
        staleHits: 1,
        integrityViolations: 2,
        budgetViolations: 1,
        hitRateAtK: 1,
        meanRecallAtK: 1,
        meanPrecisionAtK: 1 / 3,
    });
    expect(result.byCategory.literal).toEqual(result.summary);
    expect(result.rows[0]).toMatchObject({
        unauthorizedHits: 1,
        staleHits: 1,
        integrityViolations: 2,
        budgetViolation: true,
        relevantHits: 1,
        state: "hit",
    });
    expect(result.rows[0].retrieved).toEqual(retrieved);
    expect(result.rows[0].retrieved).toHaveLength(7);
});

it("does not turn a denied positive query into a successful empty negative", () => {
    const denied = { ...cases[0], requester: "outsider" };
    const report = evaluateRetrieval(lab, notes, [denied], [retrievalStrategies[0]], 3);
    expect(report.strategies[0].summary.denialMismatches).toBe(1);
    expect(report.strategies[0].summary.hitCases).toBe(0);
    expect(report.strategies[0].rows[0].state).toBe("denied");
});

it("propagates unexpected retrieval failures instead of calling them absence", () => {
    expect(() =>
        evaluateRetrieval(
            lab,
            notes,
            [cases[0]],
            [
                {
                    name: "broken",
                    retrieve: () => {
                        throw new Error("retrieval_failure");
                    },
                },
            ],
            3,
        ),
    ).toThrow("retrieval_failure");
});

it("rejects invalid budgets and inconsistent ground truth", () => {
    expect(() => evaluateRetrieval(lab, notes, cases, retrievalStrategies, 0)).toThrow("invalid_limit");
    expect(() => evaluateRetrieval(lab, notes, [cases[0], cases[0]], retrievalStrategies, 3)).toThrow(
        "invalid_dataset",
    );
    expect(() =>
        evaluateRetrieval(lab, notes, [{ ...cases[0], expectedNoteIds: ["private"] }], retrievalStrategies, 3),
    ).toThrow("invalid_dataset");
    expect(() =>
        evaluateRetrieval(lab, notes, [{ ...cases[0], expectedNoteIds: ["missing"] }], retrievalStrategies, 3),
    ).toThrow("invalid_dataset");
});
