/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";

import { decodeQASpan } from "./qaSpan.ts";

// Synthetic logits test decoder invariants only; these vectors are not a benchmark.
function example() {
    return {
        context: "🧭 A mala contém um lápis azul.",
        tokenIds: [0, 10, 2, 20, 21, 22, 2, 1],
        attentionMask: [1, 1, 1, 1, 1, 1, 1, 0],
        tokenTypeIds: [0, 0, 0, 1, 1, 1, 1, 0],
        specialTokenIds: [0, 1, 2, 3],
        sepTokenId: 2,
        startLogits: { dims: [1, 8], data: [9, 50, 40, 1, 5, 0, 30, 80] },
        endLogits: { dims: [1, 8], data: [8, 50, 40, 0, 1, 6, 30, 80] },
        decode: (ids: readonly number[]) => (ids.join(",") === "21,22" ? " lápis azul " : "other"),
    };
}

describe("decodeQASpan", () => {
    it.each([
        [
            "start dimensions",
            (input: ReturnType<typeof example>) => {
                input.startLogits.dims = [8];
            },
        ],
        [
            "end dimensions",
            (input: ReturnType<typeof example>) => {
                input.endLogits.dims = [2, 4];
            },
        ],
        [
            "token count",
            (input: ReturnType<typeof example>) => {
                input.tokenIds.pop();
            },
        ],
        [
            "mask count",
            (input: ReturnType<typeof example>) => {
                input.attentionMask.pop();
            },
        ],
        [
            "logit count",
            (input: ReturnType<typeof example>) => {
                input.startLogits.data.pop();
            },
        ],
        [
            "NaN",
            (input: ReturnType<typeof example>) => {
                input.startLogits.data[3] = NaN;
            },
        ],
        [
            "infinity on padding",
            (input: ReturnType<typeof example>) => {
                input.endLogits.data[7] = Infinity;
            },
        ],
        [
            "invalid CLS",
            (input: ReturnType<typeof example>) => {
                input.tokenIds[0] = 99;
            },
        ],
        [
            "empty context",
            (input: ReturnType<typeof example>) => {
                input.context = "  ";
            },
        ],
        [
            "missing separator",
            (input: ReturnType<typeof example>) => {
                input.tokenIds[2] = 15;
            },
        ],
        [
            "padding inside context",
            (input: ReturnType<typeof example>) => {
                input.attentionMask[4] = 0;
            },
        ],
        [
            "no contextual token",
            (input: ReturnType<typeof example>) => {
                input.specialTokenIds.push(20, 21, 22);
            },
        ],
        [
            "non-binary mask",
            (input: ReturnType<typeof example>) => {
                input.attentionMask[4] = 2;
            },
        ],
        [
            "invalid token id",
            (input: ReturnType<typeof example>) => {
                input.tokenIds[4] = -1;
            },
        ],
        [
            "span overflow",
            (input: ReturnType<typeof example>) => {
                input.startLogits.data[4] = 1e308;
                input.endLogits.data[4] = 1e308;
            },
        ],
        [
            "null overflow",
            (input: ReturnType<typeof example>) => {
                input.startLogits.data[0] = 1e308;
                input.endLogits.data[0] = 1e308;
            },
        ],
        [
            "margin overflow",
            (input: ReturnType<typeof example>) => {
                input.startLogits.data[0] = -1e308;
                input.startLogits.data[4] = 1e308;
            },
        ],
    ])("should reject malformed %s before returning a prediction", (_name, mutate) => {
        const input = example();
        mutate(input);
        expect(() => decodeQASpan(input)).toThrow();
    });

    it("should use pair segment ids rather than treating a SEP in the question as its boundary", () => {
        const decode = vi.fn().mockReturnValue("literal answer");
        const input = {
            context: "A literal answer is here.",
            tokenIds: [1, 10, 2, 11, 2, 20, 2],
            attentionMask: [1, 1, 1, 1, 1, 1, 1],
            tokenTypeIds: [0, 0, 0, 0, 0, 1, 1],
            specialTokenIds: [0, 1, 2],
            sepTokenId: 2,
            startLogits: { dims: [1, 7], data: [0, 0, 0, 90, 0, 2, 0] },
            endLogits: { dims: [1, 7], data: [0, 0, 0, 90, 0, 3, 0] },
            decode,
        };
        const result = decodeQASpan(input);
        expect(decode).toHaveBeenCalledExactlyOnceWith([20]);
        expect(result.spanScore).toBe(5);
    });

    it.each([
        [
            "segment count",
            (input: ReturnType<typeof example>) => {
                input.tokenTypeIds.pop();
            },
        ],
        [
            "segment bounds",
            (input: ReturnType<typeof example>) => {
                input.tokenTypeIds[3] = 0;
            },
        ],
        [
            "segment value",
            (input: ReturnType<typeof example>) => {
                input.tokenTypeIds[4] = 2;
            },
        ],
        [
            "noncontiguous segment",
            (input: ReturnType<typeof example>) => {
                input.tokenTypeIds[4] = 0;
            },
        ],
    ])("should reject malformed %s", (_name, mutate) => {
        const input = example();
        mutate(input);
        expect(() => decodeQASpan(input)).toThrow();
    });

    it("should require start <= end while allowing a one-token answer", () => {
        const input = example();
        input.startLogits.data = [0, 90, 90, -100, 5, 10, 90, 90];
        input.endLogits.data = [0, 90, 90, 11, 4, -100, 90, 90];
        const decode = vi.fn().mockReturnValue("lápis");
        const result = decodeQASpan({ ...input, decode });
        expect(decode).toHaveBeenCalledExactlyOnceWith([21]);
        expect(result.spanScore).toBe(9);
        expect(result.margin).toBe(9);
    });

    it("should include exactly 32 tokens but never a 33-token span", () => {
        const tokenIds = [0, 10, 2, ...Array.from({ length: 34 }, (_, i) => 20 + i), 2];
        const start = tokenIds.map(() => -100);
        const end = tokenIds.map(() => -100);
        start[0] = 0;
        end[0] = 0;
        start[3] = 10;
        end[3 + 31] = 9;
        end[3 + 32] = 20;
        const decode = vi.fn().mockReturnValue("quoted answer");
        const result = decodeQASpan({
            ...example(),
            context: "A quoted answer appears here.",
            tokenIds,
            attentionMask: tokenIds.map(() => 1),
            tokenTypeIds: tokenIds.map((_, index) => (index < 3 ? 0 : 1)),
            startLogits: { dims: [1, tokenIds.length], data: start },
            endLogits: { dims: [1, tokenIds.length], data: end },
            decode,
        });
        expect(decode).toHaveBeenCalledExactlyOnceWith(tokenIds.slice(3, 3 + 32));
        expect(result.spanScore).toBe(19);
    });

    it("should never cross a special token inside the context", () => {
        const input = example();
        input.tokenIds[4] = 3;
        input.startLogits.data[3] = 6;
        input.startLogits.data[5] = 1;
        input.endLogits.data[5] = 7;
        const decode = vi.fn().mockReturnValue("azul");
        const result = decodeQASpan({ ...input, decode });
        expect(decode).toHaveBeenCalledExactlyOnceWith([22]);
        expect(result.spanScore).toBe(8);
    });

    it.each(["lápis  azul", "LÁPIS AZUL", "lapis azul", "", " \n "])(
        "should mark a nonliteral decoding unmapped without changing finite scores (%s)",
        (decoded) => {
            const result = decodeQASpan({ ...example(), decode: () => decoded });
            expect(result).toEqual({ span: null, spanScore: 11, nullScore: 17, margin: -6, unmapped: true });
        },
    );

    it("should return the first exact occurrence without Unicode normalization", () => {
        const context = "🧭 cafe\u0301 / café / café";
        const result = decodeQASpan({ ...example(), context, decode: () => " café " });
        const start = context.indexOf("café");
        expect(result.span).toEqual({ text: "café", start, end: start + "café".length });
        expect(context.slice(result.span!.start, result.span!.end)).toBe("café");
    });

    it("should propagate decoder errors", () => {
        const error = new Error("token_decode_failed");
        expect(() =>
            decodeQASpan({
                ...example(),
                decode: () => {
                    throw error;
                },
            }),
        ).toThrow(error);
    });

    it("should preserve raw CLS scores and map only the best contextual span to literal JS offsets", () => {
        const result = decodeQASpan(example());
        expect(result).toEqual({
            span: {
                text: "lápis azul",
                start: "🧭 A mala contém um ".length,
                end: "🧭 A mala contém um lápis azul".length,
            },
            spanScore: 11,
            nullScore: 17,
            margin: -6,
            unmapped: false,
        });
    });
});
