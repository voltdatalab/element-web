/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryLab } from "./MemoryLab.ts";
import { retrievalStrategies } from "./retrievalStrategies.ts";

let lab: MemoryLab;
beforeEach(() => {
    lab = new MemoryLab(":memory:");
    lab.setScope({ id: "team", kind: "shared", readers: ["owner", "peer"], agents: ["a"] });
    lab.setScope({ id: "private", kind: "dm", conversationId: "dm", readers: ["owner"], agents: ["a"] });
    lab.setConversation({ id: "room", audience: ["owner", "peer"], agents: ["a"], scopes: ["team", "private"] });
    lab.addNote({
        id: "deadline",
        scopeId: "team",
        text: "O prazo do piloto é terça-feira.",
        sourceId: "ata",
        sourceVersion: 1,
    });
    lab.addNote({
        id: "meeting",
        scopeId: "team",
        text: "A reunião da equipe é quinta-feira.",
        sourceId: "agenda",
        sourceVersion: 1,
    });
    lab.addNote({
        id: "private",
        scopeId: "private",
        text: "Prazo piloto: CANARIO_PRIVADO.",
        sourceId: "dm",
        sourceVersion: 1,
    });
});
afterEach(() => lab.close());

describe("literal retrieval baseline", () => {
    it("matches an actual phrase through the existing authorized search", () => {
        const strategy = retrievalStrategies.find((item) => item.name === "literal")!;
        expect(
            strategy.retrieve(lab, lab.beginTurn("room", "a", "owner"), "prazo do piloto", 3).map((n) => n.id),
        ).toEqual(["deadline"]);
    });

    it("ranks authorized lexical terms from a question without a phrase match", () => {
        const strategy = retrievalStrategies.find((item) => item.name === "lexical")!;
        expect(strategy).toBeDefined();
        const result = strategy.retrieve(lab, lab.beginTurn("room", "a", "owner"), "Qual é o prazo do piloto?", 3);
        expect(result.map((note) => note.id)).toEqual(["deadline"]);
        expect(JSON.stringify(result)).not.toContain("CANARIO_PRIVADO");
    });

    it.each(retrievalStrategies)("$name rejects invalid limits instead of silently changing the budget", (strategy) => {
        const turn = lab.beginTurn("room", "a", "owner");
        for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => strategy.retrieve(lab, turn, "piloto", limit)).toThrow("invalid_limit");
        }
    });

    it.each(retrievalStrategies)("$name returns no evidence for an empty question", (strategy) => {
        for (const question of ["", "  ", "\n"]) {
            expect(strategy.retrieve(lab, lab.beginTurn("room", "a", "owner"), question, 3)).toEqual([]);
        }
    });

    it.each(retrievalStrategies)("$name rejects forged and revoked turns", (strategy) => {
        expect(() => strategy.retrieve(lab, {}, "piloto", 3)).toThrow("access_denied");
        const turn = lab.beginTurn("room", "a", "owner");
        lab.setScope({ id: "team", kind: "shared", readers: [], agents: [] });
        expect(() => strategy.retrieve(lab, turn, "piloto", 3)).toThrow("access_revoked");
    });

    it("normalizes accents but does not pretend to resolve semantic synonyms", () => {
        const lexical = retrievalStrategies.find((item) => item.name === "lexical")!;
        const turn = lab.beginTurn("room", "a", "owner");
        expect(lexical.retrieve(lab, turn, "REUNIAO", 3).map((note) => note.id)).toEqual(["meeting"]);
        expect(lexical.retrieve(lab, turn, "encontro", 3)).toEqual([]);
        expect(lexical.retrieve(lab, turn, "qual é", 3)).toEqual([]);
    });

    it("limits ranking and uses a deterministic tie break", () => {
        lab.addNote({ id: "aa", scopeId: "team", text: "prazo piloto", sourceId: "aa", sourceVersion: 1 });
        lab.addNote({ id: "zz", scopeId: "team", text: "prazo piloto", sourceId: "zz", sourceVersion: 1 });
        const lexical = retrievalStrategies.find((item) => item.name === "lexical")!;
        expect(lexical.retrieve(lab, lab.beginTurn("room", "a", "owner"), "prazo piloto", 2).map((n) => n.id)).toEqual([
            "aa",
            "deadline",
        ]);
    });

    it("does not use private-document frequencies when ranking public sources", () => {
        const lexical = retrievalStrategies.find((item) => item.name === "lexical")!;
        const turn = lab.beginTurn("room", "a", "owner");
        const before = lexical.retrieve(lab, turn, "prazo reunião", 3);
        expect(before.map((note) => note.id)).toEqual(["deadline", "meeting"]);
        for (let index = 0; index < 8; index++)
            lab.addNote({
                id: `private-${index}`,
                scopeId: "private",
                text: "prazo",
                sourceId: `dm-${index}`,
                sourceVersion: 1,
            });
        expect(lexical.retrieve(lab, turn, "prazo reunião", 3)).toEqual(before);
    });
});
