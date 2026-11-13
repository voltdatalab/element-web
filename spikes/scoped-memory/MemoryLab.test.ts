/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { afterEach, describe, expect, it } from "vitest";
import { MemoryLab } from "./MemoryLab.ts";

const opened: MemoryLab[] = [];

function fixture(): MemoryLab {
    const lab = new MemoryLab(":memory:");
    opened.push(lab);
    lab.setScope({ id: "private", kind: "dm", conversationId: "dm", readers: ["owner"], agents: ["a"] });
    lab.setScope({ id: "team", kind: "shared", readers: ["owner", "peer"], agents: ["a", "b"] });
    lab.setConversation({ id: "dm", audience: ["owner"], agents: ["a"], scopes: ["private", "team"] });
    lab.setConversation({ id: "room", audience: ["owner", "peer"], agents: ["a", "b"], scopes: ["private", "team"] });
    lab.addNote({
        id: "secret",
        scopeId: "private",
        text: "fixture PRIVATE_A",
        sourceId: "private-source",
        sourceVersion: 1,
    });
    lab.addNote({ id: "public", scopeId: "team", text: "fixture TEAM", sourceId: "team-source", sourceVersion: 1 });
    return lab;
}

afterEach(() => {
    for (const lab of opened.splice(0)) lab.close();
});

describe("scoped text retrieval", () => {
    it("retrieves the approved team source without exposing a private DM to the room", () => {
        const lab = fixture();
        const turn = lab.beginTurn("room", "a", "owner");
        const result = lab.search(turn, "fixture");
        expect(result.notes.map((note) => note.id)).toEqual(["public"]);
        expect(result.text).toContain("TEAM");
        expect(result.text).not.toContain("PRIVATE_A");
    });

    it("lets both agents reuse the shared source but not the other agent's DM", () => {
        const lab = fixture();
        expect(lab.search(lab.beginTurn("dm", "a", "owner"), "fixture").notes).toHaveLength(2);
        expect(lab.search(lab.beginTurn("room", "b", "owner"), "fixture").notes.map((n) => n.id)).toEqual(["public"]);
        expect(() => lab.beginTurn("dm", "b", "owner")).toThrow("access_denied");
    });

    it("blocks a requester who does not belong to the authoritative audience", () => {
        const lab = fixture();
        expect(() => lab.beginTurn("room", "a", "outsider")).toThrow("access_denied");
        expect(() => lab.search({}, "fixture")).toThrow("access_denied");
    });

    it("revokes a retrieved batch before the text handoff", () => {
        const lab = fixture();
        const turn = lab.beginTurn("room", "a", "owner");
        const result = lab.search(turn, "fixture");
        lab.setScope({ id: "team", kind: "shared", readers: ["owner"], agents: ["a"] });
        const delivered: string[] = [];
        expect(() => lab.dispatch(turn, result, (text) => delivered.push(text))).toThrow("access_revoked");
        expect(delivered).toEqual([]);
    });

    it("never delivers a forged or cross-turn batch", () => {
        const lab = fixture();
        const turn = lab.beginTurn("dm", "a", "owner");
        const result = lab.search(turn, "fixture");
        const other = lab.beginTurn("room", "a", "owner");
        expect(() => lab.dispatch(other, result, () => {})).toThrow("access_denied");
        expect(() => lab.dispatch(turn, { ...result }, () => {})).toThrow("access_denied");
        expect(() => {
            (result.notes as unknown[]).push({});
        }).toThrow();
    });

    it("uses the corrected source version and rejects a previously prepared result", () => {
        const lab = fixture();
        const turn = lab.beginTurn("room", "a", "owner");
        const previous = lab.search(turn, "fixture");
        lab.addNote({
            id: "updated",
            scopeId: "team",
            text: "fixture UPDATED",
            sourceId: "team-source",
            sourceVersion: 2,
            supersedes: "public",
        });
        const result = lab.search(turn, "fixture");
        expect(result.notes.map((note) => [note.id, note.sourceVersion])).toEqual([["updated", 2]]);
        expect(() => lab.dispatch(turn, previous, () => {})).toThrow("stale_source");
    });

    it("retains the scope and source lineage of an extractive derived view", () => {
        const lab = fixture();
        lab.createDigest("digest", "private", ["secret"]);
        const result = lab.search(lab.beginTurn("dm", "a", "owner"), "PRIVATE_A");
        expect(result.notes.find((note) => note.id === "digest")?.parents).toEqual(["secret"]);
        expect(lab.search(lab.beginTurn("room", "a", "owner"), "PRIVATE_A").notes).toEqual([]);
        expect(() => lab.createDigest("bad", "team", ["secret", "public"])).toThrow("invalid_source");
    });

    it("rejects a correction that supersedes a digest without preserving its parents", () => {
        const lab = fixture();
        lab.createDigest("digest", "team", ["public"]);
        expect(() =>
            lab.addNote({
                id: "replacement",
                scopeId: "team",
                text: "fixture REPLACEMENT",
                sourceId: "digest:digest",
                sourceVersion: 2,
                supersedes: "digest",
            }),
        ).toThrow("invalid_source");
        const result = lab.search(lab.beginTurn("room", "a", "owner"), "fixture");
        expect(result.notes.map((note) => [note.id, note.parents])).toEqual([
            ["digest", ["public"]],
            ["public", []],
        ]);
    });

    it("invalidates a derived-only batch transitively when an original is corrected", () => {
        const lab = fixture();
        lab.addNote({
            id: "second",
            scopeId: "team",
            text: "fixture SECOND",
            sourceId: "second-source",
            sourceVersion: 1,
        });
        lab.createDigest("one", "team", ["public"]);
        lab.createDigest("two", "team", ["one", "second"]);
        const turn = lab.beginTurn("room", "a", "owner");
        // Only the second-level digest contains this text spanning two original notes.
        const query = "TEAM\nfixture SECOND";
        const result = lab.search(turn, query);
        expect(result.notes.map((note) => [note.id, note.parents])).toEqual([["two", ["one", "second"]]]);
        lab.addNote({
            id: "new",
            scopeId: "team",
            text: "fixture CORRECTED",
            sourceId: "team-source",
            sourceVersion: 2,
            supersedes: "public",
        });
        expect(lab.search(turn, query).notes).toEqual([]);
        expect(lab.search(turn, "fixture").notes.map((note) => note.id)).toEqual(["new", "second"]);
        const delivered: string[] = [];
        expect(() => lab.dispatch(turn, result, (text) => delivered.push(text))).toThrow("stale_source");
        expect(delivered).toEqual([]);
        lab.createDigest("rebuilt", "team", ["new", "second"]);
        const rebuilt = lab.search(turn, "CORRECTED\nfixture SECOND");
        expect(rebuilt.notes.map((note) => [note.id, note.parents])).toEqual([["rebuilt", ["new", "second"]]]);
        lab.dispatch(turn, rebuilt, (text) => delivered.push(text));
        expect(delivered).toEqual([rebuilt.text]);
    });

    it("refuses missing or cross-scope correction links and caller-authored derived views", () => {
        const lab = fixture();
        const note = { id: "bad", scopeId: "team", text: "fake", sourceId: "x", sourceVersion: 2 };
        expect(() => lab.addNote({ ...note, supersedes: "missing" })).toThrow("invalid_source");
        expect(() => lab.addNote({ ...note, supersedes: "secret" })).toThrow("invalid_source");
        expect(() => lab.addNote({ ...note, parents: ["secret"] })).toThrow("invalid_source");
    });

    it("refuses an unbound private scope or a destination with no audience", () => {
        const lab = fixture();
        expect(() => lab.setScope({ id: "bad", kind: "dm", readers: ["owner"], agents: ["a"] })).toThrow(
            "invalid_configuration",
        );
        expect(() => lab.setConversation({ id: "bad", audience: [], agents: ["a"], scopes: ["team"] })).toThrow(
            "invalid_configuration",
        );
    });

    it("does not reclassify a private scope or transfer its owner after revocation", () => {
        const lab = fixture();
        expect(() =>
            lab.setScope({ id: "private", kind: "shared", readers: ["owner", "peer"], agents: ["a"] }),
        ).toThrow("invalid_configuration");
        lab.setScope({ id: "private", kind: "dm", conversationId: "dm", readers: [], agents: [] });
        expect(() =>
            lab.setScope({ id: "private", kind: "dm", conversationId: "dm", readers: ["peer"], agents: ["a"] }),
        ).toThrow("invalid_configuration");
    });

    it("rejects unknown scope kinds and blank authority identifiers", () => {
        const lab = fixture();
        // Exercise runtime validation at the fixture boundary, not just TypeScript types.
        const scope = { id: "bad", kind: "unknown", readers: ["owner"], agents: ["a"] };
        expect(() => lab.setScope(scope as unknown as Parameters<MemoryLab["setScope"]>[0])).toThrow(
            "invalid_configuration",
        );
        expect(() => lab.setConversation({ id: "bad", audience: [""], agents: ["a"], scopes: ["team"] })).toThrow(
            "invalid_configuration",
        );
    });
});
