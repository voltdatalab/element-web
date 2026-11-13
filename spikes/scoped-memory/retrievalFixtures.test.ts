/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryLab } from "./MemoryLab.ts";
import { retrievalCases, retrievalNotes, seedRetrieval } from "./retrievalFixtures.ts";

const notesById = new Map(retrievalNotes.map((note) => [note.id, note]));
const supersededIds = new Set(retrievalNotes.flatMap((note) => (note.supersedes ? [note.supersedes] : [])));
const authorizedScopes: Record<string, readonly string[]> = {
    "dm-a": ["dm-a", "project"],
    "dm-b": ["dm-b", "project"],
    "room": ["project"],
    "board": ["project", "restricted"],
};

describe("retrievalFixtures", () => {
    it("should provide six initial sources per scope and two project corrections", () => {
        const initial = retrievalNotes.filter((note) => !note.supersedes);
        const corrections = retrievalNotes.filter((note) => note.supersedes);

        expect(retrievalNotes).toHaveLength(26);
        expect(initial).toHaveLength(24);
        expect(corrections).toHaveLength(2);
        expect(retrievalNotes.slice(0, 24)).toEqual(initial);
        expect(retrievalNotes.slice(24)).toEqual(corrections);
        for (const scopeId of ["dm-a", "dm-b", "project", "restricted"]) {
            expect(initial.filter((note) => note.scopeId === scopeId)).toHaveLength(6);
        }
        expect(corrections.every((note) => note.scopeId === "project")).toBe(true);
    });

    it("should provide the exact independent case distribution", () => {
        expect(retrievalCases).toHaveLength(24);
        const counts = Object.fromEntries(
            ["literal", "question", "correction", "permission", "absent", "adversarial"].map((category) => [
                category,
                retrievalCases.filter((entry) => entry.category === category).length,
            ]),
        );
        expect(counts).toEqual({ literal: 6, question: 6, correction: 4, permission: 4, absent: 2, adversarial: 2 });
    });

    it("should use unique record IDs and unambiguous source versions", () => {
        const ids = [...retrievalNotes, ...retrievalCases].map((record) => record.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.every((id) => id.trim().length > 0)).toBe(true);
        expect(new Set(retrievalNotes.map((note) => JSON.stringify([note.sourceId, note.sourceVersion]))).size).toBe(
            26,
        );
        const initial = retrievalNotes.filter((note) => !note.supersedes);
        expect(new Set(initial.map((note) => note.sourceId)).size).toBe(24);
        expect(retrievalNotes.every((note) => !note.parents?.length)).toBe(true);
        for (const note of retrievalNotes) {
            expect(note.sourceId.trim().length, note.id).toBeGreaterThan(0);
            expect(Number.isSafeInteger(note.sourceVersion), note.id).toBe(true);
            expect(note.sourceVersion, note.id).toBeGreaterThan(0);
        }
    });

    it("should append explicit corrections to the previous version of the same source and scope", () => {
        const corrections = retrievalNotes.filter((note) => note.supersedes);
        expect(new Set(corrections.map((note) => note.supersedes)).size).toBe(2);
        expect(corrections.map((note) => note.sourceId).sort()).toEqual([
            "aurora:project:prazo",
            "aurora:project:responsavel",
        ]);
        for (const note of retrievalNotes) {
            if (!note.supersedes) {
                expect(note.sourceVersion, note.id).toBe(1);
                continue;
            }
            const previous = notesById.get(note.supersedes);
            expect(previous, note.id).toBeDefined();
            expect(previous?.sourceId, note.id).toBe(note.sourceId);
            expect(previous?.scopeId, note.id).toBe(note.scopeId);
            expect(note.sourceVersion, note.id).toBe(2);
            expect(note.sourceVersion, note.id).toBeGreaterThan(previous!.sourceVersion);
            expect(retrievalNotes.indexOf(previous!), note.id).toBeLessThan(retrievalNotes.indexOf(note));
            expect(note.text, note.id).toContain("Correção explícita:");
        }
    });

    it("should keep all required project facts and distinct invented markers in the DMs", () => {
        expect(
            retrievalNotes
                .filter((note) => note.scopeId === "project" && !note.supersedes)
                .map((note) => note.sourceId)
                .sort(),
        ).toEqual([
            "aurora:project:formato",
            "aurora:project:materiais",
            "aurora:project:objetivo",
            "aurora:project:prazo",
            "aurora:project:responsavel",
            "aurora:project:reuniao",
        ]);
        const dmNotes = retrievalNotes.filter((note) => ["dm-a", "dm-b"].includes(note.scopeId));
        const markers = dmNotes.flatMap((note) => {
            const matches = note.text.match(/FICTICIO_[A-Z_]+/g) ?? [];
            expect(matches, note.id).toHaveLength(1);
            return matches;
        });
        expect(new Set(markers).size).toBe(12);
        const otherText = [
            ...retrievalNotes.filter((note) => !["dm-a", "dm-b"].includes(note.scopeId)).map((note) => note.text),
            ...retrievalCases.map((entry) => entry.question),
        ].join("\n");
        for (const marker of markers) expect(otherText).not.toContain(marker);
    });

    it.each(retrievalCases)("should keep current, authorized fixture labels for $id", (entry) => {
        expect(new Set(entry.expectedNoteIds).size).toBe(entry.expectedNoteIds.length);
        expect(new Set(entry.allowedScopeIds).size).toBe(entry.allowedScopeIds.length);
        expect(entry.allowedScopeIds).toEqual(entry.expectAccessDenied ? [] : authorizedScopes[entry.conversation]);
        expect(entry.question.trim().length).toBeGreaterThan(0);
        expect(entry.expectedAnswer === null).toBe(entry.expectedNoteIds.length === 0);
        for (const id of entry.expectedNoteIds) {
            const note = notesById.get(id);
            expect(note).toBeDefined();
            expect(supersededIds.has(id)).toBe(false);
            expect(entry.allowedScopeIds).toContain(note!.scopeId);
            expect(note!.text).toContain(entry.expectedAnswer!);
            expect(entry.question.toLocaleLowerCase("pt-BR")).not.toContain(
                entry.expectedAnswer!.toLocaleLowerCase("pt-BR"),
            );
            if (entry.category === "literal") expect(note!.text).toContain(entry.question);
            if (entry.category === "correction") expect(note!.supersedes).toBeDefined();
        }
        if (["literal", "question", "correction"].includes(entry.category)) {
            expect(entry.expectedNoteIds.length).toBeGreaterThan(0);
            expect(entry.expectedAnswer?.trim().length).toBeGreaterThan(0);
        } else {
            expect(entry.expectedNoteIds).toEqual([]);
            expect(entry.expectedAnswer).toBeNull();
        }
    });

    it("should include private and shared positives in both DMs and restricted positives on the board", () => {
        const positives = retrievalCases.filter((entry) => entry.expectedNoteIds.length > 0);
        const positiveScopes = new Set(
            positives.flatMap((entry) => entry.expectedNoteIds.map((id) => notesById.get(id)!.scopeId)),
        );
        expect([...positiveScopes].sort()).toEqual(["dm-a", "dm-b", "project", "restricted"]);
        for (const conversation of ["dm-a", "dm-b"]) {
            const scopes = new Set(
                positives
                    .filter((entry) => entry.conversation === conversation)
                    .flatMap((entry) => entry.expectedNoteIds.map((id) => notesById.get(id)!.scopeId)),
            );
            expect([...scopes].sort()).toEqual([conversation, "project"]);
        }
        expect(
            positives.some(
                (entry) =>
                    entry.conversation === "board" &&
                    entry.expectedNoteIds.some((id) => notesById.get(id)!.scopeId === "restricted"),
            ),
        ).toBe(true);
    });

    it("should use only both current correction sources and never label the replaced values", () => {
        const corrections = retrievalCases.filter((entry) => entry.category === "correction");
        expect([...new Set(corrections.flatMap((entry) => entry.expectedNoteIds))].sort()).toEqual([
            "aurora-project-prazo-v2",
            "aurora-project-responsavel-v2",
        ]);
        expect(corrections.filter((entry) => entry.expectedAnswer === "dia 23 de Brumal")).toHaveLength(2);
        expect(corrections.filter((entry) => entry.expectedAnswer === "Zunélia")).toHaveLength(2);
        for (const entry of retrievalCases) {
            expect(entry.expectedAnswer).not.toBe("Talina");
            expect(entry.expectedAnswer).not.toBe("dia 18 de Brumal");
        }
    });

    it("should leave permission and adversarial ground truth empty without exposing the requested values", () => {
        const negatives = retrievalCases.filter((entry) => ["permission", "adversarial"].includes(entry.category));
        for (const entry of negatives) {
            expect(entry.conversation).toBe("room");
            expect(entry.expectedNoteIds).toEqual([]);
            expect(entry.expectedAnswer).toBeNull();
            expect(entry.question).not.toMatch(
                /FICTICIO_|cor de amora|caixa de linho|samambaia de vidro|870|Prisma Adormecido/i,
            );
        }
        const outsider = retrievalCases.filter((entry) => entry.requester === "outsider");
        expect(outsider).toHaveLength(1);
        expect(outsider[0]).toMatchObject({ expectAccessDenied: true, allowedScopeIds: [] });
        expect(retrievalCases.filter((entry) => entry.expectAccessDenied)).toEqual(outsider);
    });

    it("should avoid URLs and Matrix identities in source text and questions", () => {
        const text = [...retrievalNotes.map((note) => note.text), ...retrievalCases.map((entry) => entry.question)];
        for (const value of text) expect(value).not.toMatch(/https?:\/\/|www\.|@[a-z\d._=-]+:[a-z\d.-]+/i);
    });
});

describe("seedRetrieval", () => {
    let lab: MemoryLab;

    beforeEach(() => {
        lab = new MemoryLab(":memory:");
    });

    afterEach(() => {
        lab.close();
        vi.restoreAllMocks();
    });

    it("should configure exactly the trusted scopes and conversations before appending all sources", () => {
        // Spies observe real configuration calls; no authorization or database behavior is replaced.
        const scopeWrites = vi.spyOn(lab, "setScope");
        const conversationWrites = vi.spyOn(lab, "setConversation");
        const noteWrites = vi.spyOn(lab, "addNote");
        seedRetrieval(lab);

        expect(scopeWrites.mock.calls.map(([scope]) => scope)).toEqual([
            { id: "dm-a", kind: "dm", conversationId: "dm-a", readers: ["owner"], agents: ["a"] },
            { id: "dm-b", kind: "dm", conversationId: "dm-b", readers: ["owner"], agents: ["b"] },
            { id: "project", kind: "shared", readers: ["owner", "peer", "director"], agents: ["a", "b"] },
            { id: "restricted", kind: "restricted", readers: ["owner", "director"], agents: ["a", "b"] },
        ]);
        expect(conversationWrites.mock.calls.map(([conversation]) => conversation)).toEqual([
            { id: "dm-a", audience: ["owner"], agents: ["a"], scopes: ["dm-a", "project"] },
            { id: "dm-b", audience: ["owner"], agents: ["b"], scopes: ["dm-b", "project"] },
            {
                id: "room",
                audience: ["owner", "peer"],
                agents: ["a", "b"],
                scopes: ["dm-a", "dm-b", "project", "restricted"],
            },
            { id: "board", audience: ["owner", "director"], agents: ["a", "b"], scopes: ["project", "restricted"] },
        ]);
        expect(noteWrites.mock.calls.map(([note]) => note)).toEqual(retrievalNotes);
        expect(Math.max(...scopeWrites.mock.invocationCallOrder)).toBeLessThan(
            Math.min(...conversationWrites.mock.invocationCallOrder),
        );
        expect(Math.max(...conversationWrites.mock.invocationCallOrder)).toBeLessThan(
            Math.min(...noteWrites.mock.invocationCallOrder),
        );
    });

    it.each(retrievalCases)("should seed the declared authorized current sources for $id", (entry) => {
        seedRetrieval(lab);
        if (entry.expectAccessDenied) {
            expect(() => lab.beginTurn(entry.conversation, entry.agent, entry.requester)).toThrow("access_denied");
            return;
        }
        const turn = lab.beginTurn(entry.conversation, entry.agent, entry.requester);
        // Empty text enumerates current authorized sources; negative cases do not require lexical silence.
        const notes = lab.search(turn, "").notes;
        expect([...new Set(notes.map((note) => note.scopeId))].sort()).toEqual([...entry.allowedScopeIds].sort());
        const currentAuthorizedIds = retrievalNotes
            .filter((note) => entry.allowedScopeIds.includes(note.scopeId) && !supersededIds.has(note.id))
            .map((note) => note.id)
            .sort();
        expect(notes.map((note) => note.id).sort()).toEqual(currentAuthorizedIds);
        for (const id of entry.expectedNoteIds) expect(currentAuthorizedIds).toContain(id);
    });

    it("should enforce the bound DM agent and the entire configured audience", () => {
        seedRetrieval(lab);
        expect(() => lab.beginTurn("dm-a", "b", "owner")).toThrow("access_denied");
        expect(() => lab.beginTurn("dm-b", "a", "owner")).toThrow("access_denied");
        expect(() => lab.beginTurn("dm-a", "a", "peer")).toThrow("access_denied");
        expect(() => lab.beginTurn("dm-b", "b", "director")).toThrow("access_denied");
        expect(() => lab.beginTurn("room", "a", "director")).toThrow("access_denied");
        expect(() => lab.beginTurn("board", "b", "peer")).toThrow("access_denied");
        for (const agent of ["a", "b"]) {
            for (const requester of ["owner", "peer"]) {
                const turn = lab.beginTurn("room", agent, requester);
                expect(new Set(lab.search(turn, "").notes.map((note) => note.scopeId))).toEqual(new Set(["project"]));
            }
            for (const requester of ["owner", "director"]) {
                const turn = lab.beginTurn("board", agent, requester);
                expect(new Set(lab.search(turn, "").notes.map((note) => note.scopeId))).toEqual(
                    new Set(["project", "restricted"]),
                );
            }
        }
    });
});
