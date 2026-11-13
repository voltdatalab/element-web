/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { expect, it } from "vitest";
import { MemoryLab } from "./MemoryLab.ts";
import { evaluateSemantic } from "./semanticEvaluation.ts";
import type { RetrievalCase } from "./retrievalTypes.ts";
import type { TextEmbedder } from "./semanticTypes.ts";

it.each([Number.NaN, Number.POSITIVE_INFINITY])("rejects non-finite abstention cutoffs", async (threshold) => {
    const lab = new MemoryLab(":memory:");
    try {
        const encoder: TextEmbedder = {
            encode: async () => {
                throw new Error("must_not_infer");
            },
            dispose: async () => {},
        };
        await expect(evaluateSemantic(lab, [], [], encoder, threshold)).rejects.toThrow("invalid_threshold");
    } finally {
        lab.close();
    }
});

it("measures raw candidates and abstention separately, with no labels or denied requests entering inference", async () => {
    const lab = new MemoryLab(":memory:");
    try {
        lab.setScope({ id: "team", kind: "shared", readers: ["owner"], agents: ["a"] });
        lab.setConversation({ id: "room", audience: ["owner"], agents: ["a"], scopes: ["team"] });
        const source = {
            id: "place",
            scopeId: "team",
            text: "A mostra fica no salão azul.",
            sourceId: "ata",
            sourceVersion: 1,
        };
        lab.addNote(source);
        const query = { conversation: "room", agent: "a", requester: "owner", question: "Onde fica?" };
        const cases: RetrievalCase[] = [
            {
                ...query,
                id: "positive",
                category: "question",
                expectedNoteIds: ["place"],
                expectedAnswer: "GABARITO_NAO_USAR",
                allowedScopeIds: ["team"],
            },
            {
                ...query,
                id: "negative",
                question: "Qual o telefone?",
                category: "absent",
                expectedNoteIds: [],
                expectedAnswer: null,
                allowedScopeIds: ["team"],
            },
            {
                ...query,
                id: "denied",
                requester: "outsider",
                category: "permission",
                expectedNoteIds: [],
                expectedAnswer: null,
                allowedScopeIds: [],
                expectAccessDenied: true,
            },
        ];
        const calls: (readonly string[])[] = [];
        // Toy vectors test evaluation plumbing; semantic quality is measured only by the real-model CLI.
        const encoder: TextEmbedder = {
            encode: async (texts) => {
                calls.push(texts);
                return [
                    [1, 0],
                    [0.6, 0.8],
                ];
            },
            dispose: async () => {},
        };
        const result = await evaluateSemantic(lab, [source], cases, encoder, 0.9, 3);
        expect(result.strategies.map((strategy) => strategy.summary.hitCases)).toEqual([1, 0]);
        expect(result.strategies.map((strategy) => strategy.summary.negativeCasesWithCandidates)).toEqual([1, 0]);
        expect(result.strategies.map((strategy) => strategy.summary.deniedCases)).toEqual([1, 1]);
        expect(result.strategies[1].abstention).toMatchObject({
            correctAbstentions: 1,
            falseAbstentions: 1,
            negativeAccepted: 0,
        });
        expect(calls).toHaveLength(2);
        expect(JSON.stringify(calls)).not.toContain("GABARITO_NAO_USAR");
    } finally {
        lab.close();
    }
});

it("revalidates earlier scoped queries after inference of a different conversation", async () => {
    const lab = new MemoryLab(":memory:");
    try {
        const sources = ["first", "second"].map((id) => ({
            id,
            scopeId: id,
            sourceId: id,
            sourceVersion: 1,
            text: `Fonte ${id}.`,
        }));
        for (const source of sources) {
            lab.setScope({ id: source.scopeId, kind: "shared", readers: ["owner"], agents: ["a"] });
            lab.setConversation({ id: source.scopeId, audience: ["owner"], agents: ["a"], scopes: [source.scopeId] });
            lab.addNote(source);
        }
        const cases: RetrievalCase[] = sources.map((source) => ({
            id: source.id,
            conversation: source.scopeId,
            agent: "a",
            requester: "owner",
            question: "Qual fonte?",
            category: "literal",
            expectedNoteIds: [source.id],
            expectedAnswer: "synthetic",
            allowedScopeIds: [source.scopeId],
        }));
        let calls = 0;
        const encoder: TextEmbedder = {
            encode: async () => {
                if (++calls === 2) lab.setScope({ id: "first", kind: "shared", readers: [], agents: ["a"] });
                return [
                    [1, 0],
                    [1, 0],
                ];
            },
            dispose: async () => {},
        };
        await expect(evaluateSemantic(lab, sources, cases, encoder, 0.9)).rejects.toThrow("access_revoked");
        expect(calls).toBe(2);
    } finally {
        lab.close();
    }
});

it("propagates encoder failures instead of classifying them as missing evidence", async () => {
    const lab = new MemoryLab(":memory:");
    try {
        lab.setScope({ id: "team", kind: "shared", readers: ["owner"], agents: ["a"] });
        lab.setConversation({ id: "room", audience: ["owner"], agents: ["a"], scopes: ["team"] });
        const source = { id: "note", scopeId: "team", sourceId: "source", sourceVersion: 1, text: "Texto fictício." };
        lab.addNote(source);
        const item: RetrievalCase = {
            id: "negative",
            conversation: "room",
            agent: "a",
            requester: "owner",
            question: "Qual telefone?",
            category: "absent",
            expectedNoteIds: [],
            expectedAnswer: null,
            allowedScopeIds: ["team"],
        };
        const encoder: TextEmbedder = {
            encode: async () => {
                throw new Error("encoder_failure");
            },
            dispose: async () => {},
        };
        await expect(evaluateSemantic(lab, [source], [item], encoder, 0.9)).rejects.toThrow("encoder_failure");
    } finally {
        lab.close();
    }
});
