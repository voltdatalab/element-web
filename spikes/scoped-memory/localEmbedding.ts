/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { prepareModelArtifacts, verifyModelArtifacts } from "./modelArtifacts.ts";
import type { TextEmbedder } from "./semanticTypes.ts";

/** Public model artifacts pinned by revision, exact byte length and SHA-256. Weights stay outside Git. */
export const MODEL_CONFIG = Object.freeze({
    id: "Xenova/multilingual-e5-small",
    revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
    dtype: "int8" as const,
    dimensions: 384,
    manifest: Object.freeze([
        Object.freeze({
            path: "config.json",
            bytes: 658,
            sha256: "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1",
        }),
        Object.freeze({
            path: "tokenizer.json",
            bytes: 17082730,
            sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
        }),
        Object.freeze({
            path: "tokenizer_config.json",
            bytes: 443,
            sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
        }),
        Object.freeze({
            path: "special_tokens_map.json",
            bytes: 167,
            sha256: "d05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7",
        }),
        Object.freeze({
            path: "quant_config.json",
            bytes: 674,
            sha256: "59d175f15264115f18c698d76e443b5d49fc6c8c599911c421405ef4f236e87d",
        }),
        Object.freeze({
            path: "onnx/model_int8.onnx",
            bytes: 118054593,
            sha256: "4d24e2bc01a447951524466ef533e52944bf48509e6552810bcee1a2711cb02c",
        }),
    ]),
});

/** Verify pinned artifacts without loading a runtime or attempting a download. */
export async function verifyModelDirectory(directory: string = modelDirectory()): Promise<void> {
    await verifyModelArtifacts(MODEL_CONFIG, directory);
}

/** Explicit preparation step; inference never calls this downloader. */
export async function prepareModelDirectory(directory: string = modelDirectory()): Promise<void> {
    await prepareModelArtifacts(MODEL_CONFIG, directory);
}

/**
 * Load only verified local artifacts on one CPU thread, with runtime downloads disabled.
 * Callers supply query:/passage: prefixes. Calls and disposal share a serial queue.
 */
export async function openLocalEmbedder(directory: string = modelDirectory()): Promise<TextEmbedder> {
    const absoluteDirectory = resolve(directory);
    await verifyModelDirectory(absoluteDirectory);
    const { env, pipeline } = await import("@huggingface/transformers");
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.fetch = async () => {
        throw new Error("network_disabled");
    };
    const extractor = await pipeline("feature-extraction", absoluteDirectory, {
        dtype: MODEL_CONFIG.dtype,
        device: "cpu",
        local_files_only: true,
        session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
    });
    let tail = Promise.resolve();
    let disposing: Promise<void> | undefined;
    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = tail.then(operation);
        // A rejected batch must not strand later batches or prevent disposal.
        tail = result.then(
            () => {},
            () => {},
        );
        return result;
    };
    return {
        encode(texts) {
            if (disposing) return Promise.reject(new Error("embedding_disposed"));
            const batch = [...texts];
            return enqueue(async () => {
                if (batch.length === 0) return [];
                const tensor = await extractor(batch, { pooling: "mean", normalize: true });
                const output: unknown = tensor.tolist();
                if (!Array.isArray(output) || output.length !== batch.length) {
                    throw new Error("embedding_output_count_mismatch");
                }
                for (const row of output) {
                    if (!Array.isArray(row) || row.length !== MODEL_CONFIG.dimensions) {
                        throw new Error("embedding_output_dimensions_mismatch");
                    }
                    if (!row.every((value: unknown) => typeof value === "number" && Number.isFinite(value))) {
                        throw new Error("embedding_output_nonfinite");
                    }
                }
                return output as number[][];
            });
        },
        dispose() {
            disposing ??= enqueue(async () => {
                await extractor.dispose();
            });
            return disposing;
        },
    };
}

/** Revision-specific cache under the caller's existing temporary directory. */
export function modelDirectory(): string {
    return join(tmpdir(), "element-agents-e5", MODEL_CONFIG.revision);
}
