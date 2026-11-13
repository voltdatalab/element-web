/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prepareModelArtifacts, verifyModelArtifacts, type ModelArtifactsConfig } from "./modelArtifacts.ts";

// Synthetic bytes exercise artifact handling without a model download or runtime.
const fixture = Buffer.from("pinned test artifact\n");
const config = Object.freeze({
    id: "fixture-org/test-model",
    revision: "0123456789abcdef0123456789abcdef01234567",
    manifest: Object.freeze([
        Object.freeze({
            path: "config.json",
            bytes: fixture.byteLength,
            sha256: createHash("sha256").update(fixture).digest("hex"),
        }),
    ]),
});

describe("modelArtifacts", () => {
    let directory: string;
    const network = vi.fn<typeof fetch>();

    const expectInvalidConfig = async (candidate: ModelArtifactsConfig, field: string): Promise<void> => {
        await expect(verifyModelArtifacts(candidate, directory)).rejects.toThrow(`model_config_invalid: ${field}`);
        await expect(prepareModelArtifacts(candidate, directory)).rejects.toThrow(`model_config_invalid: ${field}`);
        expect(network).not.toHaveBeenCalled();
        expect(await readdir(directory)).toEqual([]);
    };

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "model-artifacts-test-"));
        network.mockReset().mockRejectedValue(new Error("test_network_forbidden"));
        vi.stubGlobal("fetch", network);
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        await rm(directory, { recursive: true, force: true });
    });

    it("should verify a structurally configured artifact without a download", async () => {
        await writeFile(join(directory, "config.json"), fixture);
        await expect(verifyModelArtifacts(config, directory)).resolves.toBeUndefined();
        expect(network).not.toHaveBeenCalled();
    });

    it("should prepare nested artifacts using only the configured pinned public GET", async () => {
        const nested = { ...config, manifest: [{ ...config.manifest[0], path: "onnx/model_int8.onnx" }] };
        const timeout = vi.spyOn(AbortSignal, "timeout");
        network.mockResolvedValueOnce(new Response(fixture));

        await expect(prepareModelArtifacts(nested, directory)).resolves.toBeUndefined();
        expect(timeout).toHaveBeenCalledExactlyOnceWith(120_000);
        expect(network).toHaveBeenCalledExactlyOnceWith(
            `https://huggingface.co/${config.id}/resolve/${config.revision}/onnx/model_int8.onnx`,
            { method: "GET", credentials: "omit", redirect: "follow", signal: timeout.mock.results[0].value },
        );
        const file = join(directory, "onnx/model_int8.onnx");
        expect(await readFile(file)).toEqual(fixture);
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect(await readdir(join(directory, "onnx"))).toEqual(["model_int8.onnx"]);
        await expect(verifyModelArtifacts(nested, directory)).resolves.toBeUndefined();

        network.mockClear();
        await expect(prepareModelArtifacts(nested, directory)).resolves.toBeUndefined();
        expect(network).not.toHaveBeenCalled();
    });

    it("should honor valid hexadecimal pins without changing the configured tokens", async () => {
        const uppercase = Object.freeze({
            ...config,
            revision: config.revision.toUpperCase(),
            manifest: Object.freeze([
                Object.freeze({ ...config.manifest[0], sha256: config.manifest[0].sha256.toUpperCase() }),
            ]),
        });
        network.mockResolvedValueOnce(new Response(fixture));
        await expect(prepareModelArtifacts(uppercase, directory)).resolves.toBeUndefined();
        await expect(verifyModelArtifacts(uppercase, directory)).resolves.toBeUndefined();
        expect(network.mock.calls[0][0]).toBe(
            `https://huggingface.co/${uppercase.id}/resolve/${uppercase.revision}/config.json`,
        );
    });

    it.each([
        { data: Buffer.alloc(0), reason: "model_file_size_mismatch" },
        { data: Buffer.alloc(fixture.byteLength), reason: "model_file_sha256_mismatch" },
    ])("should preserve local verification errors without fetching: $reason", async ({ data, reason }) => {
        await writeFile(join(directory, "config.json"), data);
        await expect(verifyModelArtifacts(config, directory)).rejects.toThrow(`${reason}: config.json`);
        expect(network).not.toHaveBeenCalled();
    });

    it.each([
        { response: () => new Response("not found", { status: 404 }), reason: "model_download_http: config.json: 404" },
        { response: () => new Response(null), reason: "model_download_body_missing: config.json" },
        { response: () => new Response(fixture.subarray(1)), reason: "model_download_size_mismatch: config.json" },
        {
            response: () => new Response(Buffer.alloc(fixture.byteLength)),
            reason: "model_download_sha256_mismatch: config.json",
        },
    ])("should preserve download errors without writing: $reason", async ({ response, reason }) => {
        network.mockResolvedValueOnce(response());
        await expect(prepareModelArtifacts(config, directory)).rejects.toThrow(reason);
        expect(await readdir(directory)).toEqual([]);
        expect(network).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])(
        "should stop oversized streams and release their reader (cancel rejects: %s)",
        async (reject) => {
            const cancel = vi.fn(() =>
                reject ? Promise.reject(new Error("controlled_cancel_failure")) : Promise.resolve(),
            );
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(fixture);
                    controller.enqueue(Uint8Array.of(0));
                },
                cancel,
            });
            network.mockResolvedValueOnce(new Response(stream));
            await expect(prepareModelArtifacts(config, directory)).rejects.toThrow(
                "model_download_size_mismatch: config.json",
            );
            expect(cancel).toHaveBeenCalledTimes(1);
            expect(stream.locked).toBe(false);
            expect(await readdir(directory)).toEqual([]);
        },
    );

    it("should release a failed stream without replacing an existing corrupt cache entry", async () => {
        const corrupt = "corrupt cache";
        await writeFile(join(directory, "config.json"), corrupt);
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.error(new Error("controlled_stream_failure"));
            },
        });
        network.mockResolvedValueOnce(new Response(stream));
        await expect(prepareModelArtifacts(config, directory)).rejects.toThrow("controlled_stream_failure");
        expect(stream.locked).toBe(false);
        expect(await readFile(join(directory, "config.json"), "utf8")).toBe(corrupt);
        expect(await readdir(directory)).toEqual(["config.json"]);
    });

    it("should remove the temporary file after a failed atomic rename", async () => {
        await mkdir(join(directory, "config.json"));
        network.mockResolvedValueOnce(new Response(fixture));
        await expect(prepareModelArtifacts(config, directory)).rejects.toMatchObject({ code: "EISDIR" });
        expect(await readdir(directory)).toEqual(["config.json"]);
        expect((await stat(join(directory, "config.json"))).isDirectory()).toBe(true);
    });

    it("should write exclusively with private permissions before publishing by same-directory rename", async () => {
        const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        const write = vi.fn(fs.writeFile);
        const remove = vi.fn(fs.rm);
        const publish = vi.fn(async (temporary: string, file: string) => {
            expect(file).toBe(join(directory, "config.json"));
            expect(await fs.readFile(temporary)).toEqual(fixture);
            expect((await fs.stat(temporary)).mode & 0o777).toBe(0o600);
            await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
            await fs.rename(temporary, file);
        });
        vi.doMock("node:fs/promises", () => ({ ...fs, writeFile: write, rename: publish, rm: remove }));
        vi.resetModules();
        try {
            const artifacts = await import("./modelArtifacts.ts");
            network.mockResolvedValueOnce(new Response(fixture));
            await expect(artifacts.prepareModelArtifacts(config, directory)).resolves.toBeUndefined();
            expect(write).toHaveBeenCalledExactlyOnceWith(
                expect.stringMatching(/config\.json\.[0-9a-f-]{36}\.tmp$/),
                fixture,
                { flag: "wx", mode: 0o600 },
            );
            const temporary = write.mock.calls[0][0];
            expect(publish).toHaveBeenCalledExactlyOnceWith(temporary, join(directory, "config.json"));
            expect(remove).toHaveBeenCalledExactlyOnceWith(temporary, { force: true });
            expect(await fs.readFile(join(directory, "config.json"))).toEqual(fixture);
            expect(await fs.readdir(directory)).toEqual(["config.json"]);
        } finally {
            vi.doUnmock("node:fs/promises");
            vi.resetModules();
        }
    });

    it.each([
        "",
        "model",
        "org/model/extra",
        "/org/model",
        "org//model",
        "../model",
        "org/..",
        "https://untrusted.invalid/model",
        "org/model?token=secret",
        "org/model#fragment",
        "org\\model",
        "org%2fmodel",
        " org/model",
        "org/model\n",
    ])("should reject an invalid model identifier without normalizing it: %j", async (id) => {
        await expectInvalidConfig({ ...config, id }, "id");
    });

    it.each([
        "",
        "main",
        "a".repeat(39),
        "a".repeat(41),
        "g".repeat(40),
        `${config.revision}\n`,
        ` ${config.revision}`,
    ])("should reject a non-pinned revision without normalizing it: %j", async (revision) => {
        await expectInvalidConfig({ ...config, revision }, "revision");
    });

    it.each([
        "",
        ".",
        "..",
        "/absolute.json",
        "../outside.json",
        "onnx/../../outside.json",
        "onnx/../model.onnx",
        "onnx/./model.onnx",
        "onnx//model.onnx",
        "onnx/model.onnx/",
        "C:\\outside.json",
        "onnx\\model.onnx",
        "https://untrusted.invalid/model.onnx",
        "//untrusted.invalid/model.onnx",
        "%2e%2e/outside.json",
        "onnx/%2e%2e/model.onnx",
        "model.onnx?token=secret",
        "model.onnx#fragment",
        "model.onnx\n",
        "model.onnx\0",
    ])("should reject an unsafe path anywhere in the manifest before I/O: %j", async (path) => {
        await expectInvalidConfig(
            { ...config, manifest: [config.manifest[0], { ...config.manifest[0], path }] },
            "manifest.path",
        );
    });

    it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
        "should reject a byte length that is not a positive safe integer: %s",
        async (bytes) => {
            await expectInvalidConfig(
                { ...config, manifest: [config.manifest[0], { ...config.manifest[0], bytes }] },
                "manifest.bytes",
            );
        },
    );

    it.each(["", "a".repeat(63), "a".repeat(65), "g".repeat(64), `${"a".repeat(63)}\n`, ` ${"a".repeat(63)}`])(
        "should reject a SHA-256 pin that is not exactly 64 hexadecimal characters: %j",
        async (sha256) => {
            await expectInvalidConfig(
                { ...config, manifest: [config.manifest[0], { ...config.manifest[0], sha256 }] },
                "manifest.sha256",
            );
        },
    );
});
