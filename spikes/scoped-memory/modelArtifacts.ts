/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Code-owned public artifact pins, not user-supplied URLs or paths.
 * Identifiers are ASCII org/model names; revisions and SHA-256 pins are exactly 40 and 64 hex characters.
 * Paths are relative ASCII segments without empty, dot or parent segments; byte lengths are positive safe integers.
 */
export interface ModelArtifactsConfig {
    readonly id: string;
    readonly revision: string;
    readonly manifest: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[];
}

/** Verify pinned artifacts without loading a runtime or attempting a download. */
export async function verifyModelArtifacts(config: ModelArtifactsConfig, directory: string): Promise<void> {
    validateModelConfig(config);
    for (const artifact of config.manifest) await verifyModelFile(directory, artifact);
}

/** Explicit preparation step; inference must only verify local artifacts, never call this downloader. */
export async function prepareModelArtifacts(config: ModelArtifactsConfig, directory: string): Promise<void> {
    validateModelConfig(config);
    for (const artifact of config.manifest) {
        try {
            await verifyModelFile(directory, artifact);
            continue;
        } catch {
            // Only explicit preparation may replace a missing or unverified cache entry.
        }
        const url = `https://huggingface.co/${config.id}/resolve/${config.revision}/${artifact.path}`;
        const response = await fetch(url, {
            method: "GET",
            credentials: "omit",
            redirect: "follow",
            signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok) throw new Error(`model_download_http: ${artifact.path}: ${response.status}`);
        if (!response.body) throw new Error(`model_download_body_missing: ${artifact.path}`);
        const reader = response.body.getReader();
        const hash = createHash("sha256");
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > artifact.bytes) throw new Error(`model_download_size_mismatch: ${artifact.path}`);
                hash.update(value);
                chunks.push(value);
            }
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
        if (bytes !== artifact.bytes) throw new Error(`model_download_size_mismatch: ${artifact.path}`);
        if (!hash.digest().equals(Buffer.from(artifact.sha256, "hex"))) {
            throw new Error(`model_download_sha256_mismatch: ${artifact.path}`);
        }
        const file = join(directory, artifact.path);
        await mkdir(dirname(file), { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
            // Publish only complete, hash-verified bytes on the same filesystem.
            await writeFile(temporary, Buffer.concat(chunks, bytes), { flag: "wx", mode: 0o600 });
            await rename(temporary, file);
        } finally {
            await rm(temporary, { force: true });
        }
    }
}

function validateModelConfig(config: ModelArtifactsConfig): void {
    const identifier = config.id.split("/");
    if (
        identifier.length !== 2 ||
        identifier.some((part) => !/^[A-Za-z0-9]/.test(part) || /[^A-Za-z0-9._-]/.test(part))
    ) {
        throw new Error("model_config_invalid: id");
    }
    if (config.revision.length !== 40 || /[^A-Fa-f0-9]/.test(config.revision)) {
        throw new Error("model_config_invalid: revision");
    }
    for (const artifact of config.manifest) {
        const segments = artifact.path.split("/");
        if (segments.some((part) => !part || part === "." || part === ".." || /[^A-Za-z0-9._-]/.test(part))) {
            throw new Error("model_config_invalid: manifest.path");
        }
        if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
            throw new Error("model_config_invalid: manifest.bytes");
        }
        if (artifact.sha256.length !== 64 || /[^A-Fa-f0-9]/.test(artifact.sha256)) {
            throw new Error("model_config_invalid: manifest.sha256");
        }
    }
}

async function verifyModelFile(directory: string, artifact: ModelArtifactsConfig["manifest"][number]): Promise<void> {
    const file = join(directory, artifact.path);
    let size: number;
    try {
        size = (await stat(file)).size;
    } catch (error) {
        throw new Error(`model_file_missing: ${artifact.path}`, { cause: error });
    }
    if (size !== artifact.bytes) throw new Error(`model_file_size_mismatch: ${artifact.path}`);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(file)) {
        bytes += chunk.length;
        if (bytes > artifact.bytes) throw new Error(`model_file_size_mismatch: ${artifact.path}`);
        hash.update(chunk);
    }
    if (bytes !== artifact.bytes) throw new Error(`model_file_size_mismatch: ${artifact.path}`);
    if (!hash.digest().equals(Buffer.from(artifact.sha256, "hex"))) {
        throw new Error(`model_file_sha256_mismatch: ${artifact.path}`);
    }
}
