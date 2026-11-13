/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, expect, it } from "vitest";
import { MemoryLab } from "./MemoryLab.ts";
import { rankSemantic } from "./semanticRetrieval.ts";
import type { TextEmbedder } from "./semanticTypes.ts";

let lab: MemoryLab;
beforeEach(() => {
    lab = new MemoryLab(":memory:");
    lab.setScope({ id: "team", kind: "shared", readers: ["owner", "peer"], agents: ["a"] });
    lab.setScope({ id: "private", kind: "dm", conversationId: "dm", readers: ["owner"], agents: ["a"] });
    lab.setConversation({ id: "room", audience: ["owner", "peer"], agents: ["a"], scopes: ["team", "private"] });
    lab.addNote({
        id: "place",
        scopeId: "team",
        text: "A mostra acontece no salão azul.",
        sourceId: "ata",
        sourceVersion: 1,
    });
    lab.addNote({ id: "private", scopeId: "private", text: "CANARIO_PRIVADO", sourceId: "dm", sourceVersion: 1 });
});
afterEach(() => lab.close());

it("encodes only the authorized view and uses real vector similarity mechanics", async () => {
    const calls: (readonly string[])[] = [];
    // Fixed vectors test the gate and arithmetic, not the real model's semantic quality.
    const encoder: TextEmbedder = {
        encode: async (texts) => {
            calls.push(texts);
            return [
                [1, 0],
                [1, 0],
            ];
        },
        dispose: async () => {},
    };
    const result = await rankSemantic(lab, lab.beginTurn("room", "a", "owner"), "Onde é a exposição?", encoder, 3);
    expect(calls).toEqual([["query: Onde é a exposição?", "passage: A mostra acontece no salão azul."]]);
    expect(result.map((item) => [item.note.id, item.score])).toEqual([["place", 1]]);
    expect(JSON.stringify(calls)).not.toContain("CANARIO_PRIVADO");
});

it("sorts by similarity before applying K", async () => {
    lab.addNote({
        id: "another",
        scopeId: "team",
        text: "Um texto sem o local.",
        sourceId: "outra-ata",
        sourceVersion: 1,
    });
    const encoder: TextEmbedder = {
        encode: async () => [
            [1, 0],
            [0, 1],
            [1, 0],
        ],
        dispose: async () => {},
    };
    const ranked = await rankSemantic(lab, lab.beginTurn("room", "a", "owner"), "Onde?", encoder, 1);
    expect(ranked.map((item) => item.note.id)).toEqual(["place"]);
});

it("does not return a ranking when authorization changes during inference", async () => {
    const encoder: TextEmbedder = {
        encode: async () => {
            lab.setScope({ id: "team", kind: "shared", readers: ["owner"], agents: ["a"] });
            return [
                [1, 0],
                [1, 0],
            ];
        },
        dispose: async () => {},
    };
    await expect(rankSemantic(lab, lab.beginTurn("room", "a", "owner"), "Onde?", encoder, 3)).rejects.toThrow(
        "access_revoked",
    );
});

it.each([
    [[1, 0]],
    [[1, 0], [1]],
    [
        [1, 0],
        [Number.NaN, 1],
    ],
    [
        [0, 0],
        [1, 0],
    ],
    [
        [1, 0],
        [0, 0],
    ],
])("rejects malformed or unusable embeddings instead of inventing a ranking: %j", async (...vectors) => {
    const encoder: TextEmbedder = { encode: async () => vectors, dispose: async () => {} };
    await expect(rankSemantic(lab, lab.beginTurn("room", "a", "owner"), "Onde?", encoder, 3)).rejects.toThrow(
        "invalid_embedding",
    );
});

it("rejects forged turns before calling the encoder", async () => {
    let calls = 0;
    const encoder: TextEmbedder = {
        encode: async () => {
            calls++;
            return [];
        },
        dispose: async () => {},
    };
    await expect(rankSemantic(lab, Object.freeze({}), "Onde?", encoder, 3)).rejects.toThrow("access_denied");
    expect(calls).toBe(0);
});

it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid limit %j before inference",
    async (limit) => {
        let calls = 0;
        const encoder: TextEmbedder = {
            encode: async () => {
                calls++;
                return [
                    [1, 0],
                    [1, 0],
                ];
            },
            dispose: async () => {},
        };
        await expect(rankSemantic(lab, lab.beginTurn("room", "a", "owner"), "Onde?", encoder, limit)).rejects.toThrow(
            "invalid_limit",
        );
        expect(calls).toBe(0);
    },
);

it("does not invent candidates for an empty question", async () => {
    let calls = 0;
    const encoder: TextEmbedder = {
        encode: async () => {
            calls++;
            return [
                [1, 0],
                [1, 0],
            ];
        },
        dispose: async () => {},
    };
    expect(await rankSemantic(lab, lab.beginTurn("room", "a", "owner"), "  ", encoder, 3)).toEqual([]);
    expect(calls).toBe(0);
});

it("rejects a source corrected during inference", async () => {
    const encoder: TextEmbedder = {
        encode: async () => {
            lab.addNote({
                id: "place-v2",
                scopeId: "team",
                sourceId: "ata",
                sourceVersion: 2,
                text: "O local mudou.",
                supersedes: "place",
            });
            return [
                [1, 0],
                [1, 0],
            ];
        },
        dispose: async () => {},
    };
    await expect(rankSemantic(lab, lab.beginTurn("room", "a", "owner"), "Onde?", encoder, 3)).rejects.toThrow(
        "stale_source",
    );
});
