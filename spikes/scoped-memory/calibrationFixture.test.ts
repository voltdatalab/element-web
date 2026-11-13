/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { calibrationFixture } from "./calibrationFixture.js";

describe("calibrationFixture", () => {
    it("should identify Farol labels as synthetic rather than human annotations", () => {
        expect(calibrationFixture.name).toContain("Farol");
        expect(calibrationFixture.name).toContain("rótulos sintéticos");
        expect(calibrationFixture.name).toContain("sem anotação humana");
    });

    it("should keep a small, internally consistent and balanced question set", () => {
        const { name, passages, queries } = calibrationFixture;
        const ids = queries.map(({ id }) => id);
        const texts = [name, ...passages, ...queries.flatMap(({ id, question }) => [id, question])];

        expect(passages).toHaveLength(4);
        expect(queries).toHaveLength(8);
        expect(new Set(ids).size).toBe(queries.length);
        for (const text of texts) {
            expect(text.trim()).not.toBe("");
        }
        expect(queries.filter(({ answerable }) => answerable === true)).toHaveLength(4);
        expect(queries.filter(({ answerable }) => answerable === false)).toHaveLength(4);
    });
});
