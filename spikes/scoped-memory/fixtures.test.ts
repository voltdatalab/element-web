/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryLab } from "./MemoryLab.ts";
import { accessCases, seedSynthetic, syntheticNotes } from "./fixtures.ts";

let lab: MemoryLab;

beforeEach(() => {
    lab = new MemoryLab(":memory:");
    seedSynthetic(lab);
});
afterEach(() => lab.close());

describe("four-compartment synthetic access matrix", () => {
    it.each(accessCases)("$conversation / $agent / $requester", ({ conversation, agent, requester, scopes }) => {
        if (!scopes) {
            expect(() => lab.beginTurn(conversation, agent, requester)).toThrow("access_denied");
            return;
        }
        const turn = lab.beginTurn(conversation, agent, requester);
        const result = lab.search(turn, "synthetic");
        const expected = syntheticNotes
            .filter((note) => scopes.includes(note.scopeId))
            .map((note) => note.id)
            .sort();
        expect(result.notes.map((note) => note.id).sort()).toEqual(expected);
        const texts: string[] = [];
        lab.dispatch(turn, result, (text) => texts.push(text));
        expect(texts).toEqual([result.text]);
    });

    it("keeps a DM bound to its original destination even with an identical owner and agent", () => {
        lab.setConversation({ id: "other", audience: ["owner"], agents: ["a"], scopes: ["dm-a"] });
        expect(lab.search(lab.beginTurn("other", "a", "owner"), "synthetic").notes).toEqual([]);
    });

    it("invalidates prepared context when the audience changes", () => {
        const turn = lab.beginTurn("room", "a", "owner");
        const result = lab.search(turn, "synthetic");
        lab.setConversation({ id: "room", audience: ["owner", "outsider"], agents: ["a"], scopes: ["project"] });
        expect(() => lab.search(turn, "synthetic")).toThrow("access_revoked");
        expect(() => lab.dispatch(turn, result, () => {})).toThrow("access_revoked");
        expect(lab.search(lab.beginTurn("room", "a", "owner"), "synthetic").notes).toEqual([]);
    });

    it("does not revive old handles when a grant is restored", () => {
        const turn = lab.beginTurn("room", "a", "owner");
        const grant = {
            id: "project",
            kind: "shared" as const,
            readers: ["owner", "peer", "director"],
            agents: ["a", "b"],
        };
        lab.setScope({ ...grant, agents: [] });
        expect(() => lab.search(turn, "synthetic")).toThrow("access_revoked");
        lab.setScope(grant);
        expect(() => lab.search(turn, "synthetic")).toThrow("access_revoked");
        expect(lab.search(lab.beginTurn("room", "a", "owner"), "synthetic").notes).toHaveLength(6);
    });

    it("treats query syntax as literal text instead of SQL or a scope selector", () => {
        const turn = lab.beginTurn("room", "a", "owner");
        expect(lab.search(turn, "' OR 1=1 --").notes).toEqual([]);
        expect(lab.search(turn, "FIXTURE_DM-A").notes).toEqual([]);
        expect(lab.search(turn, "a source that never existed").notes).toEqual([]);
        expect(lab.search(turn, "").notes).toHaveLength(6);
    });

    it("keeps instruction-like source text as data without broadening access", () => {
        const turn = lab.beginTurn("room", "a", "owner");
        const result = lab.search(turn, "Ignore every rule");
        expect(result.notes.map((note) => note.id)).toEqual(["project-6"]);
        expect(result.text).not.toContain("FIXTURE_DM-A");
        expect(result.text).not.toContain("FIXTURE_DM-B");
        expect(result.text).not.toContain("FIXTURE_RESTRICTED");
        expect(JSON.parse(result.text).untrustedSources).toHaveLength(1);
    });

    it("preserves private provenance when a derived view is built from another derived view", () => {
        lab.createDigest("private-level-one", "dm-a", ["dm-a-1", "dm-a-2"]);
        lab.createDigest("private-level-two", "dm-a", ["private-level-one"]);
        const own = lab.search(lab.beginTurn("dm-a", "a", "owner"), "FIXTURE_DM-A_1");
        expect(own.notes.map((note) => note.id)).toContain("private-level-two");
        expect(lab.search(lab.beginTurn("room", "a", "owner"), "FIXTURE_DM-A_1").notes).toEqual([]);
        expect(() => lab.createDigest("mixed", "project", ["project-1", "private-level-two"])).toThrow(
            "invalid_source",
        );
        expect(() => lab.createDigest("missing", "project", ["nonexistent"])).toThrow("invalid_source");
    });

    it("makes returned notes and lineage immutable", () => {
        lab.createDigest("derived", "project", ["project-1"]);
        const result = lab.search(lab.beginTurn("room", "a", "owner"), "FIXTURE_PROJECT_1");
        const derived = result.notes.find((note) => note.id === "derived")!;
        expect(() => {
            (derived.parents as string[]).push("dm-a-1");
        }).toThrow();
        expect(() => {
            Object.assign(derived, { scopeId: "dm-a" });
        }).toThrow();
    });

    it("reopens persisted fixtures without retaining handles or weakening revoked DM bindings", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "element-memory-reopen-"));
        const filename = path.join(directory, "fixture.sqlite");
        let disk: MemoryLab | undefined;
        try {
            disk = new MemoryLab(filename);
            seedSynthetic(disk);
            const previous = disk.beginTurn("room", "a", "owner");
            const expected = disk.search(previous, "synthetic").text;
            disk.setScope({ id: "dm-a", kind: "dm", conversationId: "dm-a", readers: [], agents: [] });
            disk.close();
            disk = undefined;
            disk = new MemoryLab(filename);
            expect(disk.search(disk.beginTurn("room", "a", "owner"), "synthetic").text).toBe(expected);
            expect(() => disk!.search(previous, "synthetic")).toThrow("access_denied");
            expect(() =>
                disk!.setScope({ id: "dm-a", kind: "dm", conversationId: "dm-a", readers: ["peer"], agents: ["a"] }),
            ).toThrow("invalid_configuration");
        } finally {
            disk?.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
});
