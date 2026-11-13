/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { isIP } from "node:net";

const verificationFailed = "Matrix identity verification failed";
const maxTokenBytes = 8192;
const maxResponseBytes = 16384;
const requestTimeoutMs = 1000;

/**
 * Resolves a session proof obtained by a trusted backend against its fixed homeserver.
 * Session proofs are never MCP credentials and must not come from an MCP authorization header.
 */
export class MatrixIdentityVerifier {
    private readonly endpoint: string;
    private readonly allowedUsers: ReadonlySet<string>;

    /** Copies installation configuration; only an explicit opt-in permits literal loopback HTTP. */
    public constructor(options: { homeserver: URL; allowedUsers: ReadonlySet<string>; allowLoopbackHttp?: boolean }) {
        const endpoint = new URL(options.homeserver.href);
        const isLoopback = ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);
        const safeProtocol =
            endpoint.protocol === "https:" ||
            (endpoint.protocol === "http:" && options.allowLoopbackHttp === true && isLoopback);
        if (!safeProtocol || endpoint.username || endpoint.password || /[?#]/.test(endpoint.href)) {
            throw new Error(verificationFailed);
        }
        endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/_matrix/client/v3/account/whoami`;
        this.endpoint = endpoint.href;
        this.allowedUsers = new Set(options.allowedUsers);
        for (const user of this.allowedUsers) {
            if (!MatrixIdentityVerifier.isMatrixUserId(user)) throw new Error(verificationFailed);
        }
    }

    /** Returns the exact allowed, non-guest Matrix user ID or a generic error without upstream details. */
    public async verify(token: string): Promise<string> {
        if (typeof token !== "string" || token.length > maxTokenBytes || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) {
            throw new Error(verificationFailed);
        }
        try {
            const response = await fetch(this.endpoint, {
                method: "GET",
                headers: { Authorization: `Bearer ${token}` },
                redirect: "error",
                credentials: "omit",
                signal: AbortSignal.timeout(requestTimeoutMs),
            });
            const contentType = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
            if (
                !response.ok ||
                contentType !== "application/json" ||
                Number(response.headers.get("Content-Length")) > maxResponseBytes
            ) {
                await response.body?.cancel();
                throw new Error(verificationFailed);
            }
            const identity: unknown = await MatrixIdentityVerifier.readJson(response);
            if (
                typeof identity !== "object" ||
                identity === null ||
                Array.isArray(identity) ||
                !("user_id" in identity) ||
                typeof identity.user_id !== "string" ||
                ("is_guest" in identity && identity.is_guest !== false) ||
                !this.allowedUsers.has(identity.user_id)
            ) {
                throw new Error(verificationFailed);
            }
            return identity.user_id;
        } catch {
            // Never expose the upstream body, session proof, or an underlying error cause.
            throw new Error(verificationFailed);
        }
    }

    private static async readJson(response: Response): Promise<unknown> {
        if (!response.body) throw new Error(verificationFailed);
        const reader = response.body.getReader();
        // Fetch decodes Content-Encoding, so count streamed bytes instead of trusting Content-Length.
        const bytes = new Uint8Array(maxResponseBytes);
        let size = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (size + value.byteLength > maxResponseBytes) throw new Error(verificationFailed);
                bytes.set(value, size);
                size += value.byteLength;
            }
            return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))) as unknown;
        } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
        }
    }

    private static isMatrixUserId(value: unknown): value is string {
        // Validate the literal identifier, not a URL parser's normalized hostname or path.
        if (typeof value !== "string" || value.length > 255) return false;
        const match = /^@[a-z0-9._=/-]+:(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(value);
        if (!match) return false;
        const [, server, port] = match;
        if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return false;
        if (server.startsWith("[")) return isIP(server.slice(1, -1)) === 6;
        if (/^[0-9.]+$/.test(server)) return isIP(server) === 4;
        return server.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
    }
}
