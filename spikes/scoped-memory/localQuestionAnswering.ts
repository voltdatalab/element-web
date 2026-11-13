/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { tmpdir } from "node:os";
import { join } from "node:path";

import { type ModelArtifactsConfig, verifyModelArtifacts } from "./modelArtifacts.ts";
import { decodeQASpan } from "./qaSpan.ts";
import type { ExtractiveReader } from "./questionAnsweringTypes.ts";

/** Public multilingual base, English SQuAD2 fine-tune, pinned int8 ONNX conversion (upstream declares MIT). */
export const QA_MODEL_CONFIG = Object.freeze({
    id: "onnx-community/mdeberta-v3-base-squad2-ONNX",
    revision: "2ff2ab03627f6f3e83c3570d8c937caee33b47b5",
    manifest: Object.freeze(
        [
            {
                path: "config.json",
                bytes: 940,
                sha256: "7dd4adfb4fc7659791bcb613eb90fa8d9fa153e32e970b52322bf0bdf7c6cd83",
            },
            {
                path: "tokenizer.json",
                bytes: 16316127,
                sha256: "084ad8ee5b669fffbb68687976f431035903b78c49e31f66fdce58282e157610",
            },
            {
                path: "tokenizer_config.json",
                bytes: 1320,
                sha256: "8ed46b81ea76d196fe045ad0ef929e9d979eebada05c86898b55c0829439c659",
            },
            {
                path: "special_tokens_map.json",
                bytes: 971,
                sha256: "63cd5b53789b3b5ae2c3d7aa377bcba1557ff0b41dc69ce07b94350ea32291c2",
            },
            {
                path: "quantize_config.json",
                bytes: 310,
                sha256: "9b60b5877b9a1687b5cddbc06124a974cb7536af9dbf5295279bf73c3823170c",
            },
            {
                path: "onnx/model_int8.onnx",
                bytes: 317132975,
                sha256: "2ff59491f8fd97b9852bc168502766d9623323183fd0661176616314cdce7580",
            },
        ].map((artifact) => Object.freeze(artifact)),
    ),
} satisfies ModelArtifactsConfig);

/** Isolated cache keyed by the immutable model revision; preparation is always explicit. */
export function qaModelDirectory(): string {
    return join(tmpdir(), "element-agents-qa", QA_MODEL_CONFIG.revision);
}

/** Verify every local artifact before importing the raw-logit QA runtime; never downloads during reads. */
export async function openLocalQuestionAnswerer(directory = qaModelDirectory()): Promise<ExtractiveReader> {
    await verifyModelArtifacts(QA_MODEL_CONFIG, directory);
    const { AutoTokenizer, AutoModelForQuestionAnswering, env } = await import("@huggingface/transformers");
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.fetch = async () => {
        throw new Error("network_disabled");
    };
    const tokenizer = await AutoTokenizer.from_pretrained(directory, { local_files_only: true });
    const model = await AutoModelForQuestionAnswering.from_pretrained(directory, {
        local_files_only: true,
        dtype: "int8",
        device: "cpu",
        session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
    });
    let queue: Promise<void> = Promise.resolve();
    let disposePromise: Promise<void> | undefined;
    let disposed = false;
    function serialize<T>(operation: () => Promise<T>): Promise<T> {
        const result = queue.then(operation);
        // A failed read must not prevent the next read or disposal from running.
        queue = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }
    return {
        read: (question, context) => {
            if (disposePromise || disposed) return Promise.reject(new Error("qa_reader_disposed"));
            if (typeof question !== "string" || !question.trim())
                return Promise.reject(new Error("qa_invalid_question"));
            if (typeof context !== "string" || !context.trim()) return Promise.reject(new Error("qa_invalid_context"));
            // Only immutable primitive strings are captured by queued work, never mutable caller objects.
            const inputQuestion = question;
            const inputContext = context;
            return serialize(async () => {
                if (disposed) throw new Error("qa_reader_disposed");
                const inputs = tokenizer(inputQuestion, {
                    text_pair: inputContext,
                    padding: true,
                    truncation: true,
                    return_token_type_ids: true,
                });
                const ids = numericTensor(inputs.input_ids);
                const mask = numericTensor(inputs.attention_mask);
                const segments = numericTensor(inputs.token_type_ids);
                for (const tensor of [ids, mask, segments]) {
                    if (
                        tensor.dims.length !== 2 ||
                        tensor.dims[0] !== 1 ||
                        tensor.dims[1] !== ids.data.length ||
                        tensor.data.length !== ids.data.length
                    ) {
                        throw new Error("qa_input_shape_mismatch");
                    }
                }
                if (ids.data.some((id) => !Number.isSafeInteger(id) || id < 0)) throw new Error("qa_invalid_token_id");
                const output: unknown = await model(inputs);
                if (!output || typeof output !== "object" || !("start_logits" in output) || !("end_logits" in output)) {
                    throw new Error("qa_missing_logits");
                }
                return decodeQASpan({
                    context: inputContext,
                    tokenIds: ids.data,
                    attentionMask: mask.data,
                    tokenTypeIds: segments.data,
                    specialTokenIds: [...tokenizer.all_special_ids],
                    sepTokenId: tokenizer.sep_token_id,
                    startLogits: numericTensor(output.start_logits),
                    endLogits: numericTensor(output.end_logits),
                    decode: (tokens) =>
                        tokenizer.decode([...tokens], {
                            skip_special_tokens: true,
                            clean_up_tokenization_spaces: false,
                        }),
                });
            });
        },
        dispose: () => {
            disposePromise ??= serialize(async () => {
                disposed = true;
                await model.dispose();
            });
            return disposePromise;
        },
    };
}

function numericTensor(value: unknown): { dims: number[]; data: number[] } {
    if (
        !value ||
        typeof value !== "object" ||
        !("dims" in value) ||
        !Array.isArray(value.dims) ||
        !value.dims.every((dim: unknown) => typeof dim === "number" && Number.isSafeInteger(dim) && dim >= 0) ||
        !("data" in value) ||
        (!Array.isArray(value.data) && !ArrayBuffer.isView(value.data))
    ) {
        throw new Error("qa_invalid_tensor");
    }
    // ONNX input ids are int64; copying detaches scoring from runtime-owned tensor buffers.
    const data = Array.from(value.data as ArrayLike<unknown>, (item) => {
        if (typeof item === "number") return item;
        if (typeof item === "bigint" && Number.isSafeInteger(Number(item))) return Number(item);
        throw new Error("qa_invalid_tensor_value");
    });
    return { dims: [...value.dims], data };
}
