/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import type { ExtractivePrediction } from "./questionAnsweringTypes.ts";

/** Raw single-pair QA tensors and a synchronous token decoder; no model or source normalization. */
export interface QASpanInput {
    context: string;
    tokenIds: readonly number[];
    attentionMask: readonly number[];
    /** Pair segment ids distinguish context from question even when question text contains a separator. */
    tokenTypeIds: readonly number[];
    specialTokenIds: readonly number[];
    sepTokenId: number;
    startLogits: { dims: readonly number[]; data: ArrayLike<number> };
    endLogits: { dims: readonly number[]; data: ArrayLike<number> };
    decode: (tokenIds: readonly number[]) => string;
}

/** Select the best contextual span without a probability transform or an abstention threshold. */
export function decodeQASpan(input: QASpanInput): ExtractivePrediction {
    const { tokenIds, attentionMask, tokenTypeIds, startLogits, endLogits } = input;
    const count = tokenIds.length;
    if (typeof input.context !== "string" || !input.context.trim()) throw new Error("qa_invalid_context");
    if (count === 0 || attentionMask.length !== count || tokenTypeIds.length !== count)
        throw new Error("qa_token_count_mismatch");
    for (const logits of [startLogits, endLogits]) {
        if (
            logits.dims.length !== 2 ||
            logits.dims[0] !== 1 ||
            logits.dims[1] !== count ||
            logits.data.length !== count
        ) {
            throw new Error("qa_logit_shape_mismatch");
        }
        for (let i = 0; i < count; i++) {
            if (!Number.isFinite(logits.data[i])) throw new Error("qa_nonfinite_logit");
        }
    }
    let padded = false;
    for (let i = 0; i < count; i++) {
        if (!Number.isSafeInteger(tokenIds[i]) || tokenIds[i] < 0) throw new Error("qa_invalid_token_id");
        if (attentionMask[i] !== 0 && attentionMask[i] !== 1) throw new Error("qa_invalid_attention_mask");
        if (attentionMask[i] === 0) padded = true;
        else if (padded) throw new Error("qa_noncontiguous_attention_mask");
    }
    const specials = new Set(input.specialTokenIds);
    if (!specials.has(tokenIds[0]) || tokenIds[0] === input.sepTokenId || attentionMask[0] !== 1) {
        throw new Error("qa_missing_cls_special");
    }
    if (!Number.isSafeInteger(input.sepTokenId) || !specials.has(input.sepTokenId)) {
        throw new Error("qa_invalid_separator");
    }
    const contextStart = tokenTypeIds.indexOf(1);
    const activeEnd = attentionMask.lastIndexOf(1);
    const contextEnd = tokenIds.lastIndexOf(input.sepTokenId, activeEnd);
    if (
        contextStart <= 1 ||
        tokenIds[contextStart - 1] !== input.sepTokenId ||
        contextEnd < contextStart ||
        contextEnd !== activeEnd
    ) {
        throw new Error("qa_invalid_context_bounds");
    }
    for (let i = 0; i < count; i++) {
        if (tokenTypeIds[i] !== 0 && tokenTypeIds[i] !== 1) throw new Error("qa_invalid_segment_id");
        if (attentionMask[i] && tokenTypeIds[i] !== (i >= contextStart ? 1 : 0)) {
            throw new Error("qa_noncontiguous_context_segment");
        }
    }
    let bestStart = -1;
    let bestEnd = -1;
    let spanScore = -Infinity;
    for (let start = contextStart; start < contextEnd; start++) {
        if (!attentionMask[start] || specials.has(tokenIds[start])) continue;
        for (let end = start; end < Math.min(contextEnd, start + 32); end++) {
            if (!attentionMask[end] || specials.has(tokenIds[end])) break;
            const score = startLogits.data[start] + endLogits.data[end];
            if (score > spanScore) {
                spanScore = score;
                bestStart = start;
                bestEnd = end;
            }
        }
    }
    if (bestStart < 0) throw new Error("qa_no_contextual_token");
    const nullScore = startLogits.data[0] + endLogits.data[0];
    const margin = spanScore - nullScore;
    if (![spanScore, nullScore, margin].every(Number.isFinite)) throw new Error("qa_nonfinite_score");
    const decoded = input.decode(tokenIds.slice(bestStart, bestEnd + 1)).trim();
    const offset = decoded ? input.context.indexOf(decoded) : -1;
    return {
        span:
            offset < 0
                ? null
                : {
                      text: input.context.slice(offset, offset + decoded.length),
                      start: offset,
                      end: offset + decoded.length,
                  },
        spanScore,
        nullScore,
        margin: spanScore - nullScore,
        unmapped: offset < 0,
    };
}
