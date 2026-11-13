/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { expect, it } from "vitest";
import { MemoryLab } from "./MemoryLab.ts";
import { readScopedEvidence } from "./readScopedEvidence.ts";
import type { ExtractivePrediction, ExtractiveReader } from "./questionAnsweringTypes.ts";
import type { TextEmbedder } from "./semanticTypes.ts";

function labWithNote(): MemoryLab {
    const lab = new MemoryLab(":memory:");
    lab.setScope({ id: "team", kind: "shared", readers: ["owner"], agents: ["a"] });
    lab.setConversation({ id: "room", audience: ["owner"], agents: ["a"], scopes: ["team"] });
    lab.addNote({ id: "note", scopeId: "team", text: "Um trecho autorizado.", sourceId: "source", sourceVersion: 1 });
    return lab;
}

it.each([0, -1])("keeps the same raw span but abstains when the null score wins or ties: %j", async (margin) => {
    const lab = labWithNote();
    try {
        const reader: ExtractiveReader = {
            read: async (_question, context) => ({
                span: { text: context, start: 0, end: context.length },
                spanScore: margin,
                nullScore: 0,
                margin,
                unmapped: false,
            }),
            dispose: async () => {},
        };
        const result = await readScopedEvidence(lab, lab.beginTurn("room", "a", "owner"), "Qual?", reader);
        expect(result.forced.state).toBe("answered");
        expect(result.nullAware).toEqual({ state: "model_abstain", answer: null });
    } finally {
        lab.close();
    }
});

it.each(["grant", "source"])("rejects changes during the reader await: %s", async (change) => {
    const lab = labWithNote();
    try {
        const reader: ExtractiveReader = {
            read: async (_question, context) => {
                if (change === "grant") lab.setScope({ id: "team", kind: "shared", readers: [], agents: ["a"] });
                else
                    lab.addNote({
                        id: "v2",
                        scopeId: "team",
                        text: "Nova versão.",
                        sourceId: "source",
                        sourceVersion: 2,
                        supersedes: "note",
                    });
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
        await expect(readScopedEvidence(lab, lab.beginTurn("room", "a", "owner"), "Qual?", reader)).rejects.toThrow(
            change === "grant" ? "access_revoked" : "stale_source",
        );
    } finally {
        lab.close();
    }
});

it.each(["invented", "bounds", "nonfinite", "margin", "inconsistent", "mapping"])(
    "rejects invalid reader data: %s",
    async (kind) => {
        const lab = labWithNote();
        try {
            const reader: ExtractiveReader = {
                read: async (_question, context) => {
                    const p: ExtractivePrediction = {
                        span: { text: context, start: 0, end: context.length },
                        spanScore: 1,
                        nullScore: 0,
                        margin: 1,
                        unmapped: false,
                    };
                    if (kind === "invented") p.span!.text = "MODEL_INVENTOU";
                    if (kind === "bounds") p.span!.start = -1;
                    if (kind === "nonfinite") p.spanScore = Infinity;
                    if (kind === "margin") p.margin = NaN;
                    if (kind === "inconsistent") p.margin = 9;
                    if (kind === "mapping") p.unmapped = true;
                    return p;
                },
                dispose: async () => {},
            };
            await expect(readScopedEvidence(lab, lab.beginTurn("room", "a", "owner"), "Qual?", reader)).rejects.toThrow(
                "invalid_qa_prediction",
            );
        } finally {
            lab.close();
        }
    },
);

it.each([1, 0, -1])("does not count an unquotable span as recognizing missing evidence: %j", async (margin) => {
    const lab = labWithNote();
    try {
        const reader: ExtractiveReader = {
            read: async () => ({ span: null, spanScore: margin, nullScore: 0, margin, unmapped: true }),
            dispose: async () => {},
        };
        const result = await readScopedEvidence(lab, lab.beginTurn("room", "a", "owner"), "Qual?", reader);
        expect(result.forced).toEqual({ state: "unmapped_span", answer: null });
        expect(result.nullAware).toEqual({ state: "unmapped_span", answer: null });
    } finally {
        lab.close();
    }
});

it("snapshots each prediction before later reader calls can reuse and mutate its object", async () => {
    const lab = labWithNote();
    try {
        lab.addNote({ id: "z-second", scopeId: "team", text: "Outro trecho.", sourceId: "second", sourceVersion: 1 });
        const shared: ExtractivePrediction = { span: null, spanScore: 0, nullScore: 0, margin: 0, unmapped: false };
        let calls = 0;
        const reader: ExtractiveReader = {
            read: async (_question, context) => {
                shared.span = { text: context, start: 0, end: context.length };
                shared.spanScore = shared.margin = ++calls === 1 ? 2 : 1;
                return shared;
            },
            dispose: async () => {},
        };
        const result = await readScopedEvidence(lab, lab.beginTurn("room", "a", "owner"), "Qual?", reader);
        expect(result.forced.answer?.text).toBe("Um trecho autorizado.");
        expect(result.candidates[0].prediction.span?.text).toBe(result.candidates[0].note.text);
    } finally {
        lab.close();
    }
});

it("uses the unchanged semantic top K before reading, rather than choosing candidates from labels", async () => {
    const lab = labWithNote();
    try {
        lab.addNote({ id: "a-first", scopeId: "team", text: "Outro assunto.", sourceId: "other", sourceVersion: 1 });
        const calls: string[] = [];
        const reader: ExtractiveReader = {
            read: async (_question, context) => {
                calls.push(context);
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
        const encoder: TextEmbedder = {
            encode: async () => [
                [1, 0],
                [0, 1],
                [1, 0],
            ],
            dispose: async () => {},
        };
        const result = await readScopedEvidence(lab, lab.beginTurn("room", "a", "owner"), "Qual?", reader, encoder, 1);
        expect(calls).toEqual(["Um trecho autorizado."]);
        expect(result.forced.answer?.citation.noteId).toBe("note");
    } finally {
        lab.close();
    }
});

it.each([0, -1, 1.5, NaN, Infinity])("rejects an invalid candidate limit before reading: %j", async (limit) => {
    const lab = labWithNote();
    try {
        const reader: ExtractiveReader = {
            read: async () => {
                throw new Error("must_not_read");
            },
            dispose: async () => {},
        };
        await expect(
            readScopedEvidence(lab, lab.beginTurn("room", "a", "owner"), "Qual?", reader, undefined, limit),
        ).rejects.toThrow("invalid_limit");
    } finally {
        lab.close();
    }
});

it("does not read any passage for an empty question", async () => {
    const lab = labWithNote();
    try {
        const reader: ExtractiveReader = {
            read: async () => {
                throw new Error("must_not_read");
            },
            dispose: async () => {},
        };
        expect((await readScopedEvidence(lab, lab.beginTurn("room", "a", "owner"), "  ", reader)).nullAware.state).toBe(
            "no_candidates",
        );
        await expect(readScopedEvidence(lab, Object.freeze({}), "", reader)).rejects.toThrow("access_denied");
    } finally {
        lab.close();
    }
});

it("revalidates an empty authorized view after the ranking await before returning", async () => {
    const lab = new MemoryLab(":memory:");
    try {
        lab.setScope({ id: "team", kind: "shared", readers: ["owner"], agents: ["a"] });
        lab.setConversation({ id: "room", audience: ["owner"], agents: ["a"], scopes: ["team"] });
        const turn = lab.beginTurn("room", "a", "owner");
        const calls: string[] = [];
        const reader: ExtractiveReader = {
            read: async () => {
                calls.push("reader");
                throw new Error("must_not_read");
            },
            dispose: async () => {},
        };
        const encoder: TextEmbedder = {
            encode: async () => {
                calls.push("encoder");
                throw new Error("must_not_encode");
            },
            dispose: async () => {},
        };
        // Queue first so revocation runs after the call but before the already-resolved ranking await resumes.
        queueMicrotask(() => lab.setScope({ id: "team", kind: "shared", readers: [], agents: ["a"] }));
        const pending = readScopedEvidence(lab, turn, "Qual?", reader, encoder);
        await expect(pending).rejects.toThrow("access_revoked");
        expect(calls).toEqual([]);
    } finally {
        lab.close();
    }
});

it("quotes a literal authorized answer and binds its citation to the original source", async () => {
    const lab = new MemoryLab(":memory:");
    try {
        lab.setScope({ id: "team", kind: "shared", readers: ["owner", "peer"], agents: ["a"] });
        lab.setScope({ id: "private", kind: "dm", conversationId: "dm", readers: ["owner"], agents: ["a"] });
        lab.setConversation({ id: "room", audience: ["owner", "peer"], agents: ["a"], scopes: ["team", "private"] });
        const text = "A mostra acontece no salão azul.";
        lab.addNote({ id: "place", scopeId: "team", text, sourceId: "minutes", sourceVersion: 1 });
        lab.addNote({ id: "private", scopeId: "private", text: "CANARIO_PRIVADO", sourceId: "dm", sourceVersion: 1 });
        const calls: string[][] = [];
        // Explicit toy reader tests isolation/citation mechanics, not model quality.
        const reader: ExtractiveReader = {
            read: async (question, context) => {
                calls.push([question, context]);
                const start = context.indexOf("salão azul");
                return {
                    span: { text: "salão azul", start, end: start + "salão azul".length },
                    spanScore: 2,
                    nullScore: 1,
                    margin: 1,
                    unmapped: false,
                };
            },
            dispose: async () => {},
        };
        const result = await readScopedEvidence(lab, lab.beginTurn("room", "a", "owner"), "Onde acontece?", reader);
        expect(calls).toEqual([["Onde acontece?", text]]);
        expect(result.nullAware.answer).toMatchObject({
            text: "salão azul",
            citation: { noteId: "place", sourceId: "minutes", sourceVersion: 1, scopeId: "team" },
        });
        expect(result.forced.answer).toEqual(result.nullAware.answer);
        expect(JSON.stringify(calls)).not.toContain("CANARIO_PRIVADO");
    } finally {
        lab.close();
    }
});
