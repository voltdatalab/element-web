/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as artifacts from "./modelArtifacts.ts";
import { openLocalQuestionAnswerer, QA_MODEL_CONFIG, qaModelDirectory } from "./localQuestionAnswering.ts";
import { prepareQAModel } from "./prepareQAModel.ts";

const runtime = vi.hoisted(() => ({
    imported: vi.fn(),
    env: { allowLocalModels: false, allowRemoteModels: true, fetch: globalThis.fetch },
    tokenizer: vi.fn(),
    model: vi.fn(),
    dispose: vi.fn(),
    tokenizerLoad: vi.fn(),
    modelLoad: vi.fn(),
}));

vi.mock("@huggingface/transformers", () => {
    runtime.imported();
    return {
        env: runtime.env,
        AutoTokenizer: { from_pretrained: runtime.tokenizerLoad },
        AutoModelForQuestionAnswering: { from_pretrained: runtime.modelLoad },
    };
});

function outputLogits() {
    return {
        start_logits: { dims: [1, 6], data: Float32Array.from([10, 80, 80, 5, 0, 80]) },
        end_logits: { dims: [1, 6], data: Float32Array.from([10, 80, 80, 0, 6, 80]) },
    };
}

function configureRuntime() {
    const tokenizer = Object.assign(runtime.tokenizer, {
        sep_token_id: 2,
        all_special_ids: [0, 1, 2],
        decode: vi.fn().mockReturnValue(" a green notebook "),
    });
    tokenizer.mockReturnValue({
        input_ids: { dims: [1, 6], data: BigInt64Array.from([0n, 10n, 2n, 20n, 21n, 2n]) },
        attention_mask: { dims: [1, 6], data: BigInt64Array.from([1n, 1n, 1n, 1n, 1n, 1n]) },
        token_type_ids: { dims: [1, 6], data: BigInt64Array.from([0n, 0n, 0n, 1n, 1n, 1n]) },
    });
    runtime.model.mockResolvedValue(outputLogits());
    runtime.dispose.mockResolvedValue(undefined);
    runtime.tokenizerLoad.mockResolvedValue(tokenizer);
    runtime.modelLoad.mockResolvedValue(Object.assign(runtime.model, { dispose: runtime.dispose }));
    return tokenizer;
}

// This mocked runtime checks lifecycle/transport contracts, not model quality or benchmark accuracy.
describe("openLocalQuestionAnswerer", () => {
    let directory: string;
    let tokenizer: ReturnType<typeof configureRuntime>;

    beforeEach(async () => {
        vi.resetAllMocks();
        tokenizer = configureRuntime();
        directory = await mkdtemp(join(tmpdir(), "qa-reader-unit-"));
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(directory, { recursive: true, force: true });
    });

    it("should reject an absent cache before importing the runtime or fetching", async () => {
        const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network_disabled"));
        await expect(openLocalQuestionAnswerer(directory)).rejects.toThrow("model_file_missing: config.json");
        expect(runtime.imported).not.toHaveBeenCalled();
        expect(runtime.modelLoad).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it("should load only verified int8 artifacts on one CPU thread and return unthresholded logits", async () => {
        const verify = vi.spyOn(artifacts, "verifyModelArtifacts").mockResolvedValue();
        const reader = await openLocalQuestionAnswerer(directory);
        expect(verify).toHaveBeenCalledWith(QA_MODEL_CONFIG, directory);
        expect(runtime.tokenizerLoad).toHaveBeenCalledWith(directory, { local_files_only: true });
        expect(runtime.modelLoad).toHaveBeenCalledWith(directory, {
            local_files_only: true,
            dtype: "int8",
            device: "cpu",
            session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
        });
        expect(runtime.env.allowLocalModels).toBe(true);
        expect(runtime.env.allowRemoteModels).toBe(false);
        await expect(runtime.env.fetch("https://example.invalid/model")).rejects.toThrow("network_disabled");
        expect(await reader.read("What is inside the box?", "Inside is a green notebook.")).toEqual({
            span: { text: "a green notebook", start: 10, end: 26 },
            spanScore: 11,
            nullScore: 20,
            margin: -9,
            unmapped: false,
        });
        expect(tokenizer).toHaveBeenCalledWith("What is inside the box?", {
            text_pair: "Inside is a green notebook.",
            padding: true,
            truncation: true,
            return_token_type_ids: true,
        });
        expect(tokenizer.decode).toHaveBeenCalledWith([20, 21], {
            skip_special_tokens: true,
            clean_up_tokenization_spaces: false,
        });
        await reader.dispose();
    });

    it("should serialize reads before one idempotent disposal and reject all later reads", async () => {
        vi.spyOn(artifacts, "verifyModelArtifacts").mockResolvedValue();
        const gate = Promise.withResolvers<ReturnType<typeof outputLogits>>();
        runtime.model.mockImplementationOnce(() => gate.promise);
        const reader = await openLocalQuestionAnswerer(directory);
        const first = reader.read("First question?", "Inside is a green notebook.");
        const second = reader.read("Second question?", "Inside is a green notebook.");
        const dispose = reader.dispose();
        const repeated = reader.dispose();
        try {
            await Promise.resolve();
            expect(runtime.model).toHaveBeenCalledTimes(1);
            expect(runtime.dispose).not.toHaveBeenCalled();
            expect(dispose).toBe(repeated);
            await expect(reader.read("Too late?", "Inside is a green notebook.")).rejects.toThrow("qa_reader_disposed");
        } finally {
            gate.resolve(outputLogits());
            await Promise.allSettled([first, second, dispose, repeated]);
        }
        expect(runtime.model).toHaveBeenCalledTimes(2);
        expect(tokenizer.mock.calls.map(([question]) => question)).toEqual(["First question?", "Second question?"]);
        expect(runtime.dispose).toHaveBeenCalledTimes(1);
        await expect(reader.read("Disposed?", "A context")).rejects.toThrow("qa_reader_disposed");
    });

    it.each([
        ["", "A context"],
        ["A question?", "  "],
        [42, "A context"],
        ["A question?", new String("A mutable boxed context")],
    ])("should reject nonprimitive or empty inputs before invoking the tokenizer (%s)", async (question, context) => {
        vi.spyOn(artifacts, "verifyModelArtifacts").mockResolvedValue();
        const reader = await openLocalQuestionAnswerer(directory);
        try {
            await expect(reader.read(question as string, context as string)).rejects.toThrow("qa_invalid_");
            expect(tokenizer).not.toHaveBeenCalled();
            expect(runtime.model).not.toHaveBeenCalled();
        } finally {
            await reader.dispose();
        }
    });

    it("should propagate model failures without poisoning the serialized queue", async () => {
        vi.spyOn(artifacts, "verifyModelArtifacts").mockResolvedValue();
        const error = new Error("inference_failed");
        runtime.model.mockRejectedValueOnce(error);
        const reader = await openLocalQuestionAnswerer(directory);
        const failed = reader.read("A question?", "Inside is a green notebook.");
        const next = reader.read("Another question?", "Inside is a green notebook.");
        await expect(failed).rejects.toBe(error);
        await expect(next).resolves.toMatchObject({ spanScore: 11, nullScore: 20 });
        await reader.dispose();
        expect(runtime.dispose).toHaveBeenCalledTimes(1);
    });

    it("should propagate a disposal failure once and never reuse the disposed model", async () => {
        vi.spyOn(artifacts, "verifyModelArtifacts").mockResolvedValue();
        const error = new Error("disposal_failed");
        runtime.dispose.mockRejectedValue(error);
        const reader = await openLocalQuestionAnswerer(directory);
        const disposing = reader.dispose();
        await expect(disposing).rejects.toBe(error);
        expect(reader.dispose()).toBe(disposing);
        await expect(reader.dispose()).rejects.toBe(error);
        await expect(reader.read("Question?", "A context")).rejects.toThrow("qa_reader_disposed");
        expect(runtime.dispose).toHaveBeenCalledTimes(1);
        expect(runtime.model).not.toHaveBeenCalled();
    });

    it.each([
        { dims: [6], data: [0, 10, 2, 20, 21, 2] },
        { dims: [1, 5], data: [0, 10, 2, 20, 21, 2] },
        { dims: [1, 6], data: [0, 10, 2, NaN, 21, 2] },
        { dims: [1, 6], data: [0, 10, 2, -1, 21, 2] },
        { dims: [1, 6], data: [0, 10, 2, 1.5, 21, 2] },
        { dims: [1, 6], data: [0n, 10n, 2n, 9007199254740993n, 21n, 2n] },
        { dims: [1, 6], data: ["0", "10", "2", "20", "21", "2"] },
    ])("should reject malformed input tensors before invoking the model (%s)", async (inputIds) => {
        vi.spyOn(artifacts, "verifyModelArtifacts").mockResolvedValue();
        tokenizer.mockReturnValue({
            input_ids: inputIds,
            attention_mask: { dims: [1, 6], data: [1, 1, 1, 1, 1, 1] },
            token_type_ids: { dims: [1, 6], data: [0, 0, 0, 1, 1, 1] },
        });
        const reader = await openLocalQuestionAnswerer(directory);
        try {
            await expect(reader.read("A question?", "A context")).rejects.toThrow("qa_");
            expect(runtime.model).not.toHaveBeenCalled();
        } finally {
            await reader.dispose();
        }
    });

    it.each([
        undefined,
        {},
        { ...outputLogits(), start_logits: { dims: [6], data: [0, 0, 0, 0, 0, 0] } },
        { ...outputLogits(), end_logits: { dims: [1, 6], data: [0, 0, 0, 0, NaN, 0] } },
        { ...outputLogits(), end_logits: { dims: [1, 6], data: [0, 0, 0] } },
    ])("should propagate invalid model output as an error rather than abstention (%j)", async (output) => {
        vi.spyOn(artifacts, "verifyModelArtifacts").mockResolvedValue();
        runtime.model.mockResolvedValue(output);
        const reader = await openLocalQuestionAnswerer(directory);
        try {
            await expect(reader.read("A question?", "A context")).rejects.toThrow("qa_");
        } finally {
            await reader.dispose();
        }
    });

    it("should prepare only the fixed model cache and print its pinned manifest after success", async () => {
        const prepare = vi.spyOn(artifacts, "prepareModelArtifacts").mockResolvedValue();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await prepareQAModel();
        expect(prepare).toHaveBeenCalledExactlyOnceWith(QA_MODEL_CONFIG, qaModelDirectory());
        expect(log).toHaveBeenCalledTimes(1);
        expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({
            ...QA_MODEL_CONFIG,
            directory: qaModelDirectory(),
        });
    });

    it("should propagate preparation failures without printing a success manifest", async () => {
        const error = new Error("download_checksum_failed");
        vi.spyOn(artifacts, "prepareModelArtifacts").mockRejectedValue(error);
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await expect(prepareQAModel()).rejects.toBe(error);
        expect(log).not.toHaveBeenCalled();
    });

    it("should reject CLI arguments without preparing or printing a manifest", () => {
        const result = spawnSync(
            process.execPath,
            [
                "--import",
                'data:text/javascript,globalThis.fetch=async()=>{throw new Error("network_disabled_cli_test")}',
                fileURLToPath(new URL("./prepareQAModel.ts", import.meta.url)),
                "--unexpected",
            ],
            { encoding: "utf8", timeout: 10_000 },
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("usage: node prepareQAModel.ts (no arguments)");
        expect(result.stderr).not.toContain("network_disabled_cli_test");
    });

    it("should use the immutable revision as the default local cache directory", () => {
        expect(QA_MODEL_CONFIG.id).toBe("onnx-community/mdeberta-v3-base-squad2-ONNX");
        expect(QA_MODEL_CONFIG.revision).toBe("2ff2ab03627f6f3e83c3570d8c937caee33b47b5");
        expect(qaModelDirectory()).toBe(join(tmpdir(), "element-agents-qa", QA_MODEL_CONFIG.revision));
        expect(QA_MODEL_CONFIG.manifest.map((file) => file.path)).toEqual([
            "config.json",
            "tokenizer.json",
            "tokenizer_config.json",
            "special_tokens_map.json",
            "quantize_config.json",
            "onnx/model_int8.onnx",
        ]);
    });
});
