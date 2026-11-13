/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { expect, it } from "vitest";
import { MemoryLab } from "./MemoryLab.ts";
import { evaluateEvidence } from "./evidenceEvaluation.ts";
import type { MemoryNote } from "./memoryTypes.ts";
import type { ExtractivePrediction, ExtractiveReader } from "./questionAnsweringTypes.ts";
import type { RetrievalCase } from "./retrievalTypes.ts";
import type { TextEmbedder } from "./semanticTypes.ts";

const source: MemoryNote = {
    id: "place",
    scopeId: "team",
    sourceId: "minutes",
    sourceVersion: 1,
    text: "A mostra fica no salão azul.",
};

function setup(): MemoryLab {
    const lab = new MemoryLab(":memory:");
    lab.setScope({ id: "team", kind: "shared", readers: ["owner"], agents: ["a"] });
    lab.setConversation({ id: "room", audience: ["owner"], agents: ["a"], scopes: ["team"] });
    lab.addNote(source);
    return lab;
}

function item(overrides: Partial<RetrievalCase> = {}): RetrievalCase {
    return {
        id: "positive",
        conversation: "room",
        agent: "a",
        requester: "owner",
        question: "Onde fica?",
        category: "question",
        expectedNoteIds: [source.id],
        expectedAnswer: "SALÃO AZUL!",
        allowedScopeIds: [source.scopeId],
        ...overrides,
    };
}

function quote(context: string, text = context, margin = 1): ExtractivePrediction {
    const start = context.indexOf(text);
    return {
        span: { text, start, end: start + text.length },
        spanScore: margin,
        nullScore: 0,
        margin,
        unmapped: false,
    };
}

// These deterministic toy models exercise evaluation plumbing, never real-model answer quality.
const encoder: TextEmbedder = { encode: async (texts) => texts.map(() => [1, 0]), dispose: async () => {} };
const reader: ExtractiveReader = {
    read: async (_question, context) => quote(context, "salão azul"),
    dispose: async () => {},
};

it("reports source-bound literal agreement, both decisions, diagnostics and audited retrieval", async () => {
    const lab = setup();
    try {
        const result = await evaluateEvidence(lab, [source], [item()], reader, encoder);
        expect(result).toMatchObject({ schemaVersion: 1, limit: 3, cases: 1 });
        expect(result.strategies.map((strategy) => strategy.name)).toEqual(["extractive_forced", "extractive_null"]);
        for (const strategy of result.strategies) {
            expect(strategy.summary).toMatchObject({
                positiveCases: 1,
                negativeCases: 0,
                positiveAnswered: 1,
                positiveAbstentions: 0,
                sourceBoundExactCount: 1,
                sourceBoundExactRate: 1,
                meanSourceBoundTokenF1: 1,
                retrievalHitCases: 1,
                retrievalMisses: 0,
            });
            expect(strategy.rows[0]).toMatchObject({
                caseId: "positive",
                question: "Onde fica?",
                category: "question",
                expectedAnswer: "SALÃO AZUL!",
                expectedNoteIds: ["place"],
                accessDenied: false,
                retrievalHit: true,
                sourceBoundExact: true,
                sourceBoundTokenF1: 1,
                decision: {
                    state: "answered",
                    answer: {
                        text: "salão azul",
                        citation: { noteId: "place", sourceId: "minutes", scopeId: "team", sourceVersion: 1 },
                    },
                },
                reading: { candidates: [{ note: { id: "place" }, retrievalScore: 1, prediction: { margin: 1 } }] },
            });
            expect(strategy.byCategory.question).toEqual(strategy.summary);
        }
        expect(result.retrieval.summary).toMatchObject({
            hitCases: 1,
            unauthorizedHits: 0,
            staleHits: 0,
            integrityViolations: 0,
            budgetViolations: 0,
        });
        expect(result.retrieval.rows[0].retrieved.map((note) => note.id)).toEqual(["place"]);
    } finally {
        lab.close();
    }
});

it("separates negatives and expected denials from positive-only EM/F1 without leaking answer keys", async () => {
    const lab = setup();
    try {
        lab.setConversation({ id: "empty", audience: ["owner"], agents: ["a"], scopes: [] });
        const positive = (id: string, overrides: Partial<RetrievalCase> = {}) =>
            item({ id, question: id, ...overrides });
        const negative = (id: string, overrides: Partial<RetrievalCase> = {}) =>
            positive(id, {
                expectedAnswer: null,
                expectedNoteIds: [],
                category: "absent",
                ...overrides,
            });
        const cases = [
            positive("literal"),
            positive("partial"),
            positive("positive-null"),
            positive("canary", { expectedAnswer: "GABARITO_NAO_ENVIAR" }),
            negative("negative-answer"),
            negative("negative-null"),
            negative("unmapped"),
            negative("no-evidence", { conversation: "empty", allowedScopeIds: [] }),
            negative("denied", {
                requester: "outsider",
                category: "permission",
                allowedScopeIds: [],
                expectAccessDenied: true,
            }),
        ];
        const readerCalls: string[][] = [];
        const encoderCalls: (readonly string[])[] = [];
        const toyReader: ExtractiveReader = {
            read: async (question, context) => {
                readerCalls.push([question, context]);
                if (question === "unmapped")
                    return { span: null, spanScore: 1, nullScore: 0, margin: 1, unmapped: true };
                return quote(
                    context,
                    question === "partial" ? "salão" : "salão azul",
                    question.endsWith("null") ? 0 : 1,
                );
            },
            dispose: async () => {},
        };
        const toyEncoder: TextEmbedder = {
            encode: async (texts) => {
                encoderCalls.push([...texts]);
                return texts.map(() => [1, 0]);
            },
            dispose: async () => {},
        };
        const result = await evaluateEvidence(lab, [source], cases, toyReader, toyEncoder);
        const [forced, nullAware] = result.strategies;
        expect(forced.summary).toMatchObject({
            positiveCases: 4,
            negativeCases: 5,
            evaluatedNegatives: 4,
            deniedCases: 1,
            positiveAnswered: 4,
            positiveAbstentions: 0,
            negativeAnswers: 2,
            recognizedMissingEvidence: 0,
            unmappedNegatives: 1,
            noCandidateNegatives: 1,
            sourceBoundExactCount: 2,
            sourceBoundExactRate: 2 / 4,
            meanSourceBoundTokenF1: (2 + 2 / 3) / 4,
            retrievalHitCases: 4,
            retrievalMisses: 0,
        });
        expect(nullAware.summary).toMatchObject({
            positiveCases: 4,
            negativeCases: 5,
            evaluatedNegatives: 4,
            deniedCases: 1,
            positiveAnswered: 3,
            positiveAbstentions: 1,
            negativeAnswers: 1,
            recognizedMissingEvidence: 1,
            unmappedNegatives: 1,
            noCandidateNegatives: 1,
            sourceBoundExactCount: 1,
            sourceBoundExactRate: 1 / 4,
            meanSourceBoundTokenF1: (1 + 2 / 3) / 4,
        });
        const partial = nullAware.rows.find((row) => row.caseId === "partial")!;
        expect(partial.sourceBoundExact).toBe(false);
        expect(partial.sourceBoundTokenF1).toBeCloseTo(2 / 3);
        expect(partial.decision.answer?.text).toBe("salão");
        expect(nullAware.rows.find((row) => row.caseId === "denied")).toMatchObject({
            accessDenied: true,
            decision: { state: "access_denied", answer: null },
            reading: null,
            sourceBoundExact: false,
            sourceBoundTokenF1: 0,
        });
        expect(nullAware.byCategory.absent.sourceBoundExactRate).toBeNull();
        expect(nullAware.byCategory.absent.meanSourceBoundTokenF1).toBeNull();
        expect(nullAware.summary).not.toHaveProperty("accuracy");
        expect(forced.rows[0].reading).toBe(nullAware.rows[0].reading);
        expect(readerCalls).toHaveLength(7);
        expect(encoderCalls).toHaveLength(7);
        expect(readerCalls.map(([question]) => question)).toEqual(cases.slice(0, 7).map((entry) => entry.question));
        const modelInputs = JSON.stringify([readerCalls, encoderCalls]);
        expect(modelInputs).not.toContain("GABARITO_NAO_ENVIAR");
        expect(modelInputs).not.toContain("place");
        expect(modelInputs).not.toContain("minutes");
        expect(modelInputs).not.toContain("denied");
        expect(modelInputs).not.toContain("team");
        expect(result.retrieval.summary).toMatchObject({
            answerableCases: 4,
            hitCases: 4,
            negativeCases: 5,
            deniedCases: 1,
            denialMismatches: 0,
        });
    } finally {
        lab.close();
    }
});

it.each([0, -1])("counts unquotable negatives separately from missing evidence: %j", async (margin) => {
    const lab = setup();
    try {
        const unmappedReader: ExtractiveReader = {
            read: async () => ({ span: null, spanScore: margin, nullScore: 0, margin, unmapped: true }),
            dispose: async () => {},
        };
        const result = await evaluateEvidence(
            lab,
            [source],
            [item({ expectedNoteIds: [], expectedAnswer: null, category: "absent" })],
            unmappedReader,
            encoder,
        );
        for (const strategy of result.strategies) {
            expect(strategy.rows[0].decision).toEqual({ state: "unmapped_span", answer: null });
            expect(strategy.summary).toMatchObject({
                evaluatedNegatives: 1,
                recognizedMissingEvidence: 0,
                unmappedNegatives: 1,
                negativeAnswers: 0,
                noCandidateNegatives: 0,
            });
            expect(strategy.byCategory.absent).toEqual(strategy.summary);
        }
    } finally {
        lab.close();
    }
});

it.each(["grant", "conversation", "source", "unselected-source"])(
    "revalidates every earlier turn and its complete pre-inference snapshot after later awaits: %s",
    async (change) => {
        const lab = new MemoryLab(":memory:");
        try {
            const sources: MemoryNote[] = ["first", "second"].map((id) => ({
                id,
                scopeId: id,
                sourceId: id,
                sourceVersion: 1,
                text: `Fonte ${id}.`,
            }));
            for (const entry of sources) {
                lab.setScope({ id: entry.scopeId, kind: "shared", readers: ["owner"], agents: ["a"] });
                lab.setConversation({ id: entry.scopeId, audience: ["owner"], agents: ["a"], scopes: [entry.scopeId] });
                lab.addNote(entry);
            }
            const unselected = { ...sources[0], id: "z-unselected", sourceId: "unselected", text: "Outro trecho." };
            lab.addNote(unselected);
            sources.push(unselected);
            const cases = sources.slice(0, 2).map((entry) =>
                item({
                    id: entry.id,
                    conversation: entry.scopeId,
                    question: entry.id,
                    expectedNoteIds: [entry.id],
                    expectedAnswer: entry.text,
                    allowedScopeIds: [entry.scopeId],
                }),
            );
            let calls = 0;
            const changingReader: ExtractiveReader = {
                read: async (_question, context) => {
                    if (++calls === 2) {
                        await Promise.resolve();
                        if (change === "grant")
                            lab.setScope({ id: "first", kind: "shared", readers: [], agents: ["a"] });
                        else if (change === "conversation")
                            lab.setConversation({ id: "first", audience: ["other"], agents: ["a"], scopes: ["first"] });
                        else {
                            const old = change === "source" ? sources[0] : unselected;
                            lab.addNote({
                                ...old,
                                id: `${old.id}-v2`,
                                sourceVersion: 2,
                                supersedes: old.id,
                                text: "Nova versão.",
                            });
                        }
                    }
                    return quote(context);
                },
                dispose: async () => {},
            };
            await expect(evaluateEvidence(lab, sources, cases, changingReader, encoder, 1)).rejects.toThrow(
                change.includes("source") ? "stale_source" : "access_revoked",
            );
            expect(calls).toBe(2);
        } finally {
            lab.close();
        }
    },
);

it("checks an empty authorized snapshot across the inference await too", async () => {
    const lab = setup();
    try {
        lab.setScope({ id: "empty", kind: "shared", readers: ["owner"], agents: ["a"] });
        lab.setConversation({ id: "empty", audience: ["owner"], agents: ["a"], scopes: ["empty"] });
        const pending = evaluateEvidence(
            lab,
            [source],
            [item({ conversation: "empty", expectedNoteIds: [], expectedAnswer: null, allowedScopeIds: ["empty"] })],
            reader,
            encoder,
        );
        lab.setScope({ id: "empty", kind: "shared", readers: [], agents: ["a"] });
        await expect(pending).rejects.toThrow("access_revoked");
    } finally {
        lab.close();
    }
});

it("gives no lexical credit to an identical quote from the wrong source even when retrieval hits", async () => {
    const lab = setup();
    try {
        const decoy = { ...source, id: "decoy", sourceId: "unrelated", text: "Outro salão azul." };
        lab.addNote(decoy);
        const toyReader: ExtractiveReader = {
            read: async (_question, context) => quote(context, "salão azul", context.startsWith("Outro") ? 2 : 1),
            dispose: async () => {},
        };
        const result = await evaluateEvidence(lab, [source, decoy], [item()], toyReader, encoder);
        for (const strategy of result.strategies) {
            expect(strategy.rows[0]).toMatchObject({
                retrievalHit: true,
                sourceBoundExact: false,
                sourceBoundTokenF1: 0,
                decision: { state: "answered", answer: { text: "salão azul", citation: { noteId: "decoy" } } },
            });
            expect(strategy.summary).toMatchObject({
                positiveAnswered: 1,
                sourceBoundExactCount: 0,
                sourceBoundExactRate: 0,
                meanSourceBoundTokenF1: 0,
            });
        }
    } finally {
        lab.close();
    }
});

it("audits the unchanged semantic K3 with a retrieval miss, excluding private and superseded passages", async () => {
    const lab = setup();
    try {
        const current = { ...source, id: "place-v2", sourceVersion: 2, supersedes: source.id };
        lab.addNote(current);
        const decoys = ["a", "b", "c"].map((id) => ({ ...source, id, sourceId: id, text: `Assunto ${id}.` }));
        for (const note of decoys) lab.addNote(note);
        lab.setScope({ id: "private", kind: "restricted", readers: ["other"], agents: ["a"] });
        lab.setConversation({ id: "room", audience: ["owner"], agents: ["a"], scopes: ["team", "private"] });
        const secret = { ...source, id: "secret", sourceId: "secret", scopeId: "private", text: "CANARIO_PRIVADO" };
        lab.addNote(secret);
        const readContexts: string[] = [];
        const toyReader: ExtractiveReader = {
            read: async (_question, context) => {
                readContexts.push(context);
                return quote(context);
            },
            dispose: async () => {},
        };
        const encoded: (readonly string[])[] = [];
        const toyEncoder: TextEmbedder = {
            encode: async (texts) => {
                encoded.push([...texts]);
                return texts.map((text, index) => (index === 0 || text.includes("Assunto") ? [1, 0] : [0, 1]));
            },
            dispose: async () => {},
        };
        const result = await evaluateEvidence(
            lab,
            [source, current, ...decoys, secret],
            [item({ expectedNoteIds: [current.id] })],
            toyReader,
            toyEncoder,
        );
        expect(readContexts).toEqual(decoys.map((note) => note.text));
        expect(encoded).toEqual([
            ["query: Onde fica?", ...decoys.map((note) => `passage: ${note.text}`), `passage: ${current.text}`],
        ]);
        expect(result.retrieval.rows[0].retrieved.map((note) => note.id)).toEqual(["a", "b", "c"]);
        expect(result.retrieval.summary).toMatchObject({
            hitCases: 0,
            unauthorizedHits: 0,
            staleHits: 0,
            integrityViolations: 0,
            budgetViolations: 0,
        });
        expect(result.strategies[0].summary).toMatchObject({
            positiveCases: 1,
            retrievalHitCases: 0,
            retrievalMisses: 1,
            sourceBoundExactRate: 0,
            meanSourceBoundTokenF1: 0,
        });
    } finally {
        lab.close();
    }
});

it.each(["reader", "encoder", "reader-access-denied"])(
    "propagates the original %s error instead of scoring it as abstention",
    async (kind) => {
        const lab = setup();
        try {
            const failure = new Error(kind === "reader-access-denied" ? "access_denied" : `${kind}_failure`);
            const failingReader: ExtractiveReader = {
                read: async () => {
                    throw failure;
                },
                dispose: async () => {},
            };
            const failingEncoder: TextEmbedder = {
                encode: async () => {
                    throw failure;
                },
                dispose: async () => {},
            };
            await expect(
                evaluateEvidence(
                    lab,
                    [source],
                    [item({ expectAccessDenied: true })],
                    kind === "encoder" ? reader : failingReader,
                    kind === "encoder" ? failingEncoder : encoder,
                ),
            ).rejects.toBe(failure);
        } finally {
            lab.close();
        }
    },
);

it("propagates unexpected initial access denial before any inference", async () => {
    const lab = setup();
    try {
        const neverReader: ExtractiveReader = {
            read: async () => {
                throw new Error("must_not_read");
            },
            dispose: async () => {},
        };
        const neverEncoder: TextEmbedder = {
            encode: async () => {
                throw new Error("must_not_encode");
            },
            dispose: async () => {},
        };
        await expect(
            evaluateEvidence(lab, [source], [item({ requester: "outsider" })], neverReader, neverEncoder),
        ).rejects.toThrow("access_denied");
    } finally {
        lab.close();
    }
});

it.each([
    "duplicate-case",
    "duplicate-source",
    "missing-id",
    "duplicate-label",
    "wrong-scope",
    "stale-label",
    "invalid-limit",
])("reuses retrieval oracle validation before any inference: %s", async (kind) => {
    const lab = setup();
    try {
        const cases = [item()];
        const sources = [source];
        if (kind === "duplicate-case") cases.push(item());
        if (kind === "duplicate-source") sources.push(source);
        if (kind === "missing-id") cases[0] = item({ expectedNoteIds: ["missing"] });
        if (kind === "duplicate-label") cases[0] = item({ expectedNoteIds: [source.id, source.id] });
        if (kind === "wrong-scope") cases[0] = item({ allowedScopeIds: [] });
        if (kind === "stale-label") sources.push({ ...source, id: "v2", sourceVersion: 2, supersedes: source.id });
        const neverReader: ExtractiveReader = {
            read: async () => {
                throw new Error("must_not_read");
            },
            dispose: async () => {},
        };
        const neverEncoder: TextEmbedder = {
            encode: async () => {
                throw new Error("must_not_encode");
            },
            dispose: async () => {},
        };
        await expect(
            evaluateEvidence(lab, sources, cases, neverReader, neverEncoder, kind === "invalid-limit" ? 0 : 3),
        ).rejects.toThrow(kind === "invalid-limit" ? "invalid_limit" : "invalid_dataset");
    } finally {
        lab.close();
    }
});

it.each(["source-id", "version", "text", "scope", "stale"])(
    "retains retrieval audit violations and withholds source-bound credit: %s",
    async (kind) => {
        const lab = setup();
        try {
            let canonical = { ...source };
            let query = item();
            let extra: MemoryNote[] = [];
            if (kind === "source-id") canonical.sourceId = "other-source";
            if (kind === "version") canonical.sourceVersion = 9;
            if (kind === "text") canonical.text = "Texto diferente.";
            if (kind === "scope") query = item({ expectedNoteIds: [], expectedAnswer: null, allowedScopeIds: [] });
            if (kind === "stale") {
                extra = [{ ...source, id: "v2", sourceVersion: 2, supersedes: source.id }];
                query = item({ expectedNoteIds: ["v2"] });
            }
            const result = await evaluateEvidence(lab, [canonical, ...extra], [query], reader, encoder);
            expect(result.retrieval.summary).toMatchObject(
                kind === "scope"
                    ? { unauthorizedHits: 1 }
                    : kind === "stale"
                      ? { staleHits: 1 }
                      : { integrityViolations: 1 },
            );
            for (const strategy of result.strategies)
                expect(strategy.rows[0]).toMatchObject({ sourceBoundExact: false, sourceBoundTokenF1: 0 });
        } finally {
            lab.close();
        }
    },
);

it("handles empty datasets with no invented quality denominator", async () => {
    const lab = new MemoryLab(":memory:");
    try {
        const result = await evaluateEvidence(lab, [], [], reader, encoder);
        for (const strategy of result.strategies) {
            expect(strategy.summary).toMatchObject({
                cases: 0,
                positiveCases: 0,
                sourceBoundExactRate: null,
                meanSourceBoundTokenF1: null,
            });
            expect(strategy.rows).toEqual([]);
            expect(strategy.byCategory).toEqual({});
        }
        expect(result.retrieval.rows).toEqual([]);
    } finally {
        lab.close();
    }
});
