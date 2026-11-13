/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    MODEL_CONFIG,
    modelDirectory,
    openLocalEmbedder,
    prepareModelDirectory,
    verifyModelDirectory,
} from "./localEmbedding.ts";

// These pins are independent of the provider implementation.
const revision = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
// A small, inert JSON artifact; tests never load model weights or a tokenizer.
const configFixture = `${JSON.stringify(
    {
        _name_or_path: "intfloat/multilingual-e5-small",
        architectures: ["BertModel"],
        attention_probs_dropout_prob: 0.1,
        classifier_dropout: null,
        hidden_act: "gelu",
        hidden_dropout_prob: 0.1,
        hidden_size: 384,
        initializer_range: 0.02,
        intermediate_size: 1536,
        layer_norm_eps: 1e-12,
        max_position_embeddings: 512,
        model_type: "bert",
        num_attention_heads: 12,
        num_hidden_layers: 12,
        pad_token_id: 0,
        position_embedding_type: "absolute",
        tokenizer_class: "XLMRobertaTokenizer",
        transformers_version: "4.31.0.dev0",
        type_vocab_size: 2,
        use_cache: true,
        vocab_size: 250037,
    },
    null,
    2,
)}\n`;
const manifest = [
    {
        path: "config.json",
        bytes: 658,
        sha256: "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1",
    },
    {
        path: "tokenizer.json",
        bytes: 17082730,
        sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
    },
    {
        path: "tokenizer_config.json",
        bytes: 443,
        sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
    },
    {
        path: "special_tokens_map.json",
        bytes: 167,
        sha256: "d05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7",
    },
    {
        path: "quant_config.json",
        bytes: 674,
        sha256: "59d175f15264115f18c698d76e443b5d49fc6c8c599911c421405ef4f236e87d",
    },
    {
        path: "onnx/model_int8.onnx",
        bytes: 118054593,
        sha256: "4d24e2bc01a447951524466ef533e52944bf48509e6552810bcee1a2711cb02c",
    },
];

describe("localEmbedding", () => {
    let directory: string;
    const network = vi.fn<typeof fetch>();

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "local-embedding-test-"));
        network.mockReset().mockRejectedValue(new Error("test_network_forbidden"));
        vi.stubGlobal("fetch", network);
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        await rm(directory, { recursive: true, force: true });
    });

    it("should reject a missing artifact without fetching anything", async () => {
        await expect(verifyModelDirectory(directory)).rejects.toThrow(/model_file_missing: config\.json/);
        expect(network).not.toHaveBeenCalled();
    });

    it.each([
        { data: Buffer.from("test fixture"), reason: "model_file_size_mismatch" },
        { data: Buffer.alloc(658), reason: "model_file_sha256_mismatch" },
    ])("should reject a corrupt artifact: $reason", async ({ data, reason }) => {
        await writeFile(join(directory, "config.json"), data);
        await expect(verifyModelDirectory(directory)).rejects.toThrow(`${reason}: config.json`);
        expect(network).not.toHaveBeenCalled();
    });

    it("should request only the pinned public GET and reject an HTTP failure without writing", async () => {
        network.mockResolvedValueOnce(new Response("not found", { status: 404 }));
        await expect(prepareModelDirectory(directory)).rejects.toThrow(/model_download_http: config\.json: 404/);
        expect(network).toHaveBeenCalledExactlyOnceWith(
            `https://huggingface.co/Xenova/multilingual-e5-small/resolve/${revision}/config.json`,
            expect.objectContaining({ method: "GET", credentials: "omit" }),
        );
        expect(await readdir(directory)).toEqual([]);
    });

    it.each([
        { data: new Uint8Array(657), reason: "model_download_size_mismatch" },
        { data: new Uint8Array(659), reason: "model_download_size_mismatch" },
        { data: new Uint8Array(658), reason: "model_download_sha256_mismatch" },
    ])("should reject untrusted download bytes before writing: $reason ($data.length)", async ({ data, reason }) => {
        network.mockResolvedValueOnce(new Response(data));
        await expect(prepareModelDirectory(directory)).rejects.toThrow(`${reason}: config.json`);
        expect(await readdir(directory)).toEqual([]);
        expect(network).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])(
        "should install verified bytes atomically and reuse them (corrupt cache: %s)",
        async (corrupt) => {
            if (corrupt) await writeFile(join(directory, "config.json"), "corrupt fixture");
            network.mockResolvedValueOnce(new Response(configFixture));
            await expect(prepareModelDirectory(directory)).rejects.toThrow("test_network_forbidden");
            expect(await readFile(join(directory, "config.json"), "utf8")).toBe(configFixture);
            expect(await readdir(directory)).toEqual(["config.json"]);
            expect(network).toHaveBeenCalledTimes(2);

            network.mockClear();
            await expect(prepareModelDirectory(directory)).rejects.toThrow("test_network_forbidden");
            expect(network).toHaveBeenCalledExactlyOnceWith(
                `https://huggingface.co/Xenova/multilingual-e5-small/resolve/${revision}/tokenizer.json`,
                expect.objectContaining({ method: "GET" }),
            );
            await expect(verifyModelDirectory(directory)).rejects.toThrow("model_file_missing: tokenizer.json");
        },
    );

    it("should reject missing or tampered files before importing the inference runtime", async () => {
        const runtimeImport = vi.fn(() => {
            throw new Error("test_runtime_must_not_be_imported");
        });
        vi.doMock("@huggingface/transformers", runtimeImport);
        try {
            await expect(openLocalEmbedder(directory)).rejects.toThrow("model_file_missing: config.json");
            await writeFile(join(directory, "config.json"), Buffer.alloc(658));
            await expect(openLocalEmbedder(directory)).rejects.toThrow("model_file_sha256_mismatch: config.json");
            await writeFile(join(directory, "config.json"), configFixture);
            await expect(openLocalEmbedder(directory)).rejects.toThrow("model_file_missing: tokenizer.json");
            expect(runtimeImport).not.toHaveBeenCalled();
            expect(network).not.toHaveBeenCalled();
        } finally {
            vi.doUnmock("@huggingface/transformers");
        }
    });

    it("should pin the public model revision, quantization and all six file hashes", () => {
        expect(MODEL_CONFIG).toMatchObject({
            id: "Xenova/multilingual-e5-small",
            revision,
            dtype: "int8",
            dimensions: 384,
            manifest,
        });
        expect(modelDirectory()).toBe(join(tmpdir(), "element-agents-e5", revision));
    });
});

describe("prepareEmbeddingModel CLI", () => {
    const originalArgv = process.argv;
    const prepare = vi.fn<() => Promise<void>>();

    beforeEach(() => {
        vi.resetModules();
        prepare.mockReset().mockResolvedValue(undefined);
        vi.doMock("./localEmbedding.ts", () => ({ MODEL_CONFIG, prepareModelDirectory: prepare }));
    });

    afterEach(() => {
        process.argv = originalArgv;
        vi.doUnmock("./localEmbedding.ts");
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it("should prepare with no arguments and print only the pinned public manifest", async () => {
        process.argv = ["node", "prepareEmbeddingModel.ts"];
        const output = vi.spyOn(console, "log").mockImplementation(() => {});
        await import("./prepareEmbeddingModel.ts");
        expect(prepare).toHaveBeenCalledExactlyOnceWith();
        expect(output).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual(MODEL_CONFIG);
    });

    it("should reject every CLI argument before preparation", async () => {
        process.argv = ["node", "prepareEmbeddingModel.ts", "--model=https://untrusted.invalid"];
        await expect(import("./prepareEmbeddingModel.ts")).rejects.toThrow(/accepts no arguments/);
        expect(prepare).not.toHaveBeenCalled();
    });
});
