/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { randomUUID } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MatrixIdentityVerifier } from "./MatrixIdentityVerifier.ts";

const userId = "@demo:matrix.example.test";
const proof = `test-session-${randomUUID()}`;
const servers: Server[] = [];

async function startHomeserver(handler: RequestListener, expectedProof = proof, bindHost = "127.0.0.1") {
    const requests: { method?: string; path?: string; expectedProof: boolean; cookie: boolean }[] = [];
    const server = createServer((request, response) => {
        requests.push({
            method: request.method,
            path: request.url,
            expectedProof: request.headers.authorization === `Bearer ${expectedProof}`,
            cookie: request.headers.cookie !== undefined,
        });
        handler(request, response);
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, bindHost, resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a disposable TCP server");
    const authority = bindHost.includes(":") ? `[${bindHost}]` : bindHost;
    return { url: new URL(`http://${authority}:${address.port}`), requests };
}

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
        servers.splice(0).map(
            (server) =>
                new Promise<void>((resolve, reject) => {
                    server.closeAllConnections();
                    server.close((error) => (error ? reject(error) : resolve()));
                }),
        ),
    );
});

describe("MatrixIdentityVerifier", () => {
    it.each(["127.0.0.1", "localhost", "::1"])(
        "should accept explicit HTTP opt-in for literal %s using a real server",
        async (host) => {
            const homeserver = await startHomeserver(
                (_request, response) => {
                    response.setHeader("Content-Type", "Application/JSON; charset=utf-8");
                    response.end(JSON.stringify({ user_id: userId, is_guest: false }));
                },
                proof,
                host === "::1" ? "::1" : "127.0.0.1",
            );
            homeserver.url.hostname = host === "::1" ? "[::1]" : host;
            const verifier = new MatrixIdentityVerifier({
                homeserver: homeserver.url,
                allowedUsers: new Set([userId]),
                allowLoopbackHttp: true,
            });

            await expect(verifier.verify(proof)).resolves.toBe(userId);
            expect(homeserver.requests[0].path).toBe("/_matrix/client/v3/account/whoami");
            expect(homeserver.requests[0].expectedProof).toBe(true);
        },
    );

    it.each([
        "@test._=/-01:matrix.example.test",
        "@test:Matrix.Example.test:8448",
        "@test:127.0.0.1:8448",
        "@test:[::1]",
        "@test:[2001:db8::1]:8448",
        `@${"a".repeat(255 - "@:example.test".length)}:example.test`,
    ])("should preserve valid Matrix identifier %s literally", async (identity) => {
        const homeserver = await startHomeserver((_request, response) => {
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ user_id: identity, is_guest: false }));
        });
        const verifier = new MatrixIdentityVerifier({
            homeserver: homeserver.url,
            allowedUsers: new Set([identity]),
            allowLoopbackHttp: true,
        });

        await expect(verifier.verify(proof)).resolves.toBe(identity);
    });

    it("should freeze the configured homeserver rather than retaining a caller-owned URL", async () => {
        const destination = await startHomeserver((_request, response) => {
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ user_id: userId }));
        });
        const homeserver = await startHomeserver((_request, response) => {
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ user_id: userId }));
        });
        homeserver.url.pathname = "/prefix";
        const verifier = new MatrixIdentityVerifier({
            homeserver: homeserver.url,
            allowedUsers: new Set([userId]),
            allowLoopbackHttp: true,
        });
        homeserver.url.href = destination.url.href;

        await expect(verifier.verify(proof)).resolves.toBe(userId);
        expect(homeserver.requests[0].path).toBe("/prefix/_matrix/client/v3/account/whoami");
        expect(destination.requests.length).toBe(0);
    });

    it("should accept HTTPS configuration by default without any constructor I/O", () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        expect(
            () =>
                new MatrixIdentityVerifier({
                    homeserver: new URL("https://matrix.example.test/prefix"),
                    allowedUsers: new Set([userId]),
                }),
        ).not.toThrow();
        expect(fetchSpy.mock.calls.length).toBe(0);
    });

    it.each(["declared", "streamed"])(
        "should stop a %s oversized body without waiting for the deadline",
        async (mode) => {
            const homeserver = await startHomeserver((_request, response) => {
                response.setHeader("Content-Type", "application/json");
                if (mode === "declared") {
                    response.setHeader("Content-Length", 1_000_000);
                    response.flushHeaders();
                } else {
                    response.write(" ".repeat(16385));
                }
                const timer = setTimeout(() => response.end(), 2500);
                response.once("close", () => clearTimeout(timer));
            });
            const verifier = new MatrixIdentityVerifier({
                homeserver: homeserver.url,
                allowedUsers: new Set([userId]),
                allowLoopbackHttp: true,
            });
            const fetchSpy = vi.spyOn(globalThis, "fetch");

            await expect(verifier.verify(proof)).rejects.toThrow("Matrix identity verification failed");
            expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
            expect(homeserver.requests.length).toBe(1);
        },
    );

    it("should hide transport failures without retrying", async () => {
        const homeserver = await startHomeserver((request) => request.socket.destroy());
        const verifier = new MatrixIdentityVerifier({
            homeserver: homeserver.url,
            allowedUsers: new Set([userId]),
            allowLoopbackHttp: true,
        });

        await expect(verifier.verify(proof)).rejects.toThrow("Matrix identity verification failed");
        expect(homeserver.requests.length).toBe(1);
    });

    it.each(["headers", "body"])(
        "should abort slow %s with a short request-wide AbortSignal deadline",
        async (phase) => {
            const homeserver = await startHomeserver((_request, response) => {
                response.setHeader("Content-Type", "application/json");
                if (phase === "body") response.write('{"user_id":');
                const timer = setTimeout(() => {
                    response.end(phase === "body" ? `${JSON.stringify(userId)}}` : JSON.stringify({ user_id: userId }));
                }, 2500);
                response.once("close", () => clearTimeout(timer));
            });
            const verifier = new MatrixIdentityVerifier({
                homeserver: homeserver.url,
                allowedUsers: new Set([userId]),
                allowLoopbackHttp: true,
            });
            const fetchSpy = vi.spyOn(globalThis, "fetch");
            const started = performance.now();
            const rejectedSafely = await verifier.verify(proof).then(
                () => false,
                (error: unknown) => error instanceof Error && error.message === "Matrix identity verification failed",
            );

            expect(rejectedSafely).toBe(true);
            expect(performance.now() - started < 2300).toBe(true);
            expect(fetchSpy.mock.calls[0]?.[1]?.signal instanceof AbortSignal).toBe(true);
            expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
            expect(homeserver.requests.length).toBe(1);
        },
    );

    it.each(["content-length", "chunked", "gzip"])(
        "should reject a response exceeding 16384 decoded bytes with %s framing",
        async (framing) => {
            const body = Buffer.from(JSON.stringify({ user_id: userId, padding: "é".repeat(9000) }));
            expect(body.length > 16384).toBe(true);
            const homeserver = await startHomeserver((_request, response) => {
                response.setHeader("Content-Type", "application/json");
                if (framing === "gzip") {
                    response.setHeader("Content-Encoding", "gzip");
                    response.end(gzipSync(body));
                } else if (framing === "chunked") {
                    for (let offset = 0; offset < body.length; offset += 1024)
                        response.write(body.subarray(offset, offset + 1024));
                    response.end();
                } else {
                    response.setHeader("Content-Length", body.length);
                    response.end(body);
                }
            });
            const verifier = new MatrixIdentityVerifier({
                homeserver: homeserver.url,
                allowedUsers: new Set([userId]),
                allowLoopbackHttp: true,
            });

            await expect(verifier.verify(proof)).rejects.toThrow("Matrix identity verification failed");
            expect(homeserver.requests.length).toBe(1);
        },
    );

    it("should reject invalid UTF-8 even inside an otherwise ignored JSON property", async () => {
        const homeserver = await startHomeserver((_request, response) => {
            response.setHeader("Content-Type", "application/json");
            response.end(
                Buffer.concat([
                    Buffer.from(`{"user_id":"${userId}","padding":"`),
                    Buffer.from([0xff]),
                    Buffer.from('"}'),
                ]),
            );
        });
        const verifier = new MatrixIdentityVerifier({
            homeserver: homeserver.url,
            allowedUsers: new Set([userId]),
            allowLoopbackHttp: true,
        });

        await expect(verifier.verify(proof)).rejects.toThrow("Matrix identity verification failed");
    });

    it("should accept the exact token and response byte limits", async () => {
        const boundaryProof = "x".repeat(8192);
        const overhead = Buffer.byteLength(JSON.stringify({ user_id: userId, padding: "" }));
        const body = JSON.stringify({ user_id: userId, padding: "x".repeat(16384 - overhead) });
        expect(Buffer.byteLength(body)).toBe(16384);
        const homeserver = await startHomeserver((_request, response) => {
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(body);
        }, boundaryProof);
        const verifier = new MatrixIdentityVerifier({
            homeserver: homeserver.url,
            allowedUsers: new Set([userId]),
            allowLoopbackHttp: true,
        });

        await expect(verifier.verify(boundaryProof)).resolves.toBe(userId);
        expect(homeserver.requests[0].expectedProof).toBe(true);
    });

    it.each([204, 400, 401, 403, 404, 429, 500, 503])(
        "should reject HTTP %i when it cannot supply a successful JSON identity",
        async (status) => {
            const homeserver = await startHomeserver((_request, response) => {
                response.writeHead(status, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ user_id: userId }));
            });
            const verifier = new MatrixIdentityVerifier({
                homeserver: homeserver.url,
                allowedUsers: new Set([userId]),
                allowLoopbackHttp: true,
            });

            await expect(verifier.verify(proof)).rejects.toThrow("Matrix identity verification failed");
            expect(homeserver.requests.length).toBe(1);
        },
    );

    it.each([
        undefined,
        "text/plain",
        "text/html",
        "application/jsonp",
        "application/problem+json",
        "application/json,text/html",
    ])("should reject non-JSON Content-Type %s", async (contentType) => {
        const homeserver = await startHomeserver((_request, response) => {
            if (contentType !== undefined) response.setHeader("Content-Type", contentType);
            response.end(JSON.stringify({ user_id: userId }));
        });
        const verifier = new MatrixIdentityVerifier({
            homeserver: homeserver.url,
            allowedUsers: new Set([userId]),
            allowLoopbackHttp: true,
        });

        await expect(verifier.verify(proof)).rejects.toThrow("Matrix identity verification failed");
    });

    it.each([301, 302, 303, 307, 308])(
        "should reject HTTP %i without following to another port or host",
        async (status) => {
            const destination = await startHomeserver((_request, response) => {
                response.setHeader("Content-Type", "application/json");
                response.end(JSON.stringify({ user_id: userId }));
            });
            destination.url.hostname = "localhost";
            const homeserver = await startHomeserver((_request, response) => {
                response.writeHead(status, { Location: destination.url.href });
                response.end();
            });
            const verifier = new MatrixIdentityVerifier({
                homeserver: homeserver.url,
                allowedUsers: new Set([userId]),
                allowLoopbackHttp: true,
            });

            const rejected = await verifier.verify(proof).then(
                () => false,
                () => true,
            );
            expect(rejected).toBe(true);
            expect(homeserver.requests.length).toBe(1);
            expect(destination.requests.length).toBe(0);
            expect(homeserver.requests[0].expectedProof).toBe(true);
        },
    );

    it("should reject same-origin redirects without forwarding the session proof", async () => {
        const homeserver = await startHomeserver((request, response) => {
            if (request.url === "/redirected") {
                response.setHeader("Content-Type", "application/json");
                response.end(JSON.stringify({ user_id: userId }));
            } else {
                response.writeHead(307, { Location: "/redirected" });
                response.end();
            }
        });
        const verifier = new MatrixIdentityVerifier({
            homeserver: homeserver.url,
            allowedUsers: new Set([userId]),
            allowLoopbackHttp: true,
        });

        const rejected = await verifier.verify(proof).then(
            () => false,
            () => true,
        );
        expect(rejected).toBe(true);
        expect(homeserver.requests.length).toBe(1);
    });

    it("should explicitly omit ambient credentials and reject redirects in the real fetch", async () => {
        const homeserver = await startHomeserver((_request, response) => {
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ user_id: userId }));
        });
        const verifier = new MatrixIdentityVerifier({
            homeserver: homeserver.url,
            allowedUsers: new Set([userId]),
            allowLoopbackHttp: true,
        });
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        await expect(verifier.verify(proof)).resolves.toBe(userId);
        const options = fetchSpy.mock.calls[0]?.[1];

        expect(options?.redirect === "error").toBe(true);
        expect(options?.credentials === "omit").toBe(true);
        expect(homeserver.requests[0].expectedProof).toBe(true);
        expect(homeserver.requests[0].cookie).toBe(false);
    });

    it.each([
        "",
        "demo:matrix.example.test",
        "@:matrix.example.test",
        "@demo",
        "@demo:",
        "@Demo:matrix.example.test",
        "@démo:matrix.example.test",
        ` ${userId}`,
        `${userId} `,
        `${userId}\n`,
        "@demo:bad_domain.example",
        "@demo:matrix.example.test/path",
        "@demo:https://matrix.example.test",
        "@demo:matrix..example",
        "@demo:-matrix.example",
        "@demo:matrix-.example",
        "@demo:matrix.example.test:0",
        "@demo:matrix.example.test:65536",
        "@demo:[not-ip]",
        "@demo:[::1",
        "@demo:999.1.1.1",
        "@demo:matrix.example.test?query",
        "@demo:matrix.example.test#fragment",
        "@demo:operator@matrix.example.test",
        `@demo:${"a".repeat(64)}.test`,
        `@${"a".repeat(256)}:matrix.example.test`,
    ])("should reject invalid allowlist identifier %j without normalizing or I/O", (invalidUser) => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        expect(
            () =>
                new MatrixIdentityVerifier({
                    homeserver: new URL("https://matrix.example.test/base"),
                    allowedUsers: new Set([userId, invalidUser]),
                }),
        ).toThrow("Matrix identity verification failed");
        expect(fetchSpy.mock.calls.length).toBe(0);
    });

    it.each([
        { name: "guest", body: JSON.stringify({ user_id: userId, is_guest: true }) },
        { name: "string guest flag", body: JSON.stringify({ user_id: userId, is_guest: "false" }) },
        { name: "null guest flag", body: JSON.stringify({ user_id: userId, is_guest: null }) },
        { name: "numeric guest flag", body: JSON.stringify({ user_id: userId, is_guest: 0 }) },
        { name: "array", body: JSON.stringify([{ user_id: userId }]) },
        { name: "null", body: "null" },
        { name: "string", body: JSON.stringify(userId) },
        { name: "number", body: "123" },
        { name: "missing user", body: "{}" },
        { name: "non-string user", body: JSON.stringify({ user_id: 123 }) },
        { name: "malformed JSON", body: `not-json-${proof}` },
    ])("should reject $name whoami data with a generic error", async ({ body }) => {
        const homeserver = await startHomeserver((_request, response) => {
            response.setHeader("Content-Type", "application/json");
            response.end(body);
        });
        const verifier = new MatrixIdentityVerifier({
            homeserver: homeserver.url,
            allowedUsers: new Set([userId]),
            allowLoopbackHttp: true,
        });
        const rejectedSafely = await verifier.verify(proof).then(
            () => false,
            (error: unknown) =>
                error instanceof Error &&
                error.message === "Matrix identity verification failed" &&
                error.cause === undefined &&
                !String(error.stack).includes(proof),
        );

        expect(rejectedSafely).toBe(true);
        expect(homeserver.requests.length).toBe(1);
    });

    it.each([
        { name: "empty", value: "" },
        { name: "whitespace", value: " " },
        { name: "leading whitespace", value: ` ${proof}` },
        { name: "trailing whitespace", value: `${proof} ` },
        { name: "header injection", value: `${proof}\r\nX-Injected: yes` },
        { name: "trailing LF", value: `${proof}\n` },
        { name: "trailing CR", value: `${proof}\r` },
        { name: "trailing CRLF", value: `${proof}\r\n` },
        { name: "tab", value: `${proof}\t` },
        { name: "NUL", value: `${proof}\0` },
        { name: "non-ASCII", value: "invented-é" },
        { name: "over 8192 bytes", value: "x".repeat(8193) },
        { name: "absurd size", value: "x".repeat(1_000_000) },
        { name: "runtime non-string", value: undefined as unknown as string },
    ])("should reject $name session proof without calling fetch", async ({ value }) => {
        const homeserver = await startHomeserver((_request, response) => {
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ user_id: userId }));
        });
        const verifier = new MatrixIdentityVerifier({
            homeserver: homeserver.url,
            allowedUsers: new Set([userId]),
            allowLoopbackHttp: true,
        });
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const rejectedSafely = await verifier.verify(value).then(
            () => false,
            (error: unknown) => error instanceof Error && error.message === "Matrix identity verification failed",
        );

        expect(rejectedSafely).toBe(true);
        expect(fetchSpy.mock.calls.length).toBe(0);
        expect(homeserver.requests.length).toBe(0);
    });

    it.each([
        "@other:matrix.example.test",
        "@Demo:matrix.example.test",
        "@demo:Matrix.Example.test",
        `${userId} `,
        "@demo:matrix.example.test:8448",
    ])("should reject whoami %s outside the literal copied allowlist", async (otherUser) => {
        const homeserver = await startHomeserver((_request, response) => {
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ user_id: otherUser }));
        });
        const allowedUsers = new Set([userId]);
        const verifier = new MatrixIdentityVerifier({
            homeserver: homeserver.url,
            allowedUsers,
            allowLoopbackHttp: true,
        });
        allowedUsers.add(otherUser);

        await expect(verifier.verify(proof)).rejects.toThrow("Matrix identity verification failed");
        expect(homeserver.requests.length).toBe(1);
    });

    it("should retain allowed users after the caller mutates its set", async () => {
        const homeserver = await startHomeserver((_request, response) => {
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ user_id: userId }));
        });
        const allowedUsers = new Set([userId]);
        const verifier = new MatrixIdentityVerifier({
            homeserver: homeserver.url,
            allowedUsers,
            allowLoopbackHttp: true,
        });
        allowedUsers.clear();

        await expect(verifier.verify(proof)).resolves.toBe(userId);
    });

    it.each([
        ["http://127.0.0.1", undefined],
        ["http://localhost", false],
        ["http://[::1]", undefined],
        ["http://127.0.0.1", "true" as unknown as boolean],
        ["http://matrix.example.test", true],
        ["http://127.0.0.2", true],
        ["http://localhost.example.test", true],
        ["http://localhost.", true],
        ["http://[::ffff:127.0.0.1]", true],
        ["ftp://127.0.0.1", true],
        ["https://operator:invented@matrix.example.test", false],
        ["https://matrix.example.test/?scope=whoami", false],
        ["https://matrix.example.test/#fragment", false],
        ["https://matrix.example.test/?", false],
        ["https://matrix.example.test/#", false],
    ])("should reject unsafe homeserver configuration %s before I/O", (url, allowLoopbackHttp) => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        expect(
            () =>
                new MatrixIdentityVerifier({
                    homeserver: new URL(url),
                    allowedUsers: new Set([userId]),
                    allowLoopbackHttp,
                }),
        ).toThrow("Matrix identity verification failed");
        expect(fetchSpy.mock.calls.length).toBe(0);
    });

    it("should return the allowed whoami identity using the configured base path", async () => {
        const homeserver = await startHomeserver((_request, response) => {
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ user_id: userId }));
        });
        homeserver.url.pathname = "/matrix/base/";
        const verifier = new MatrixIdentityVerifier({
            homeserver: homeserver.url,
            allowedUsers: new Set([userId]),
            allowLoopbackHttp: true,
        });

        await expect(verifier.verify(proof)).resolves.toBe(userId);
        expect(homeserver.requests).toEqual([
            {
                method: "GET",
                path: "/matrix/base/_matrix/client/v3/account/whoami",
                expectedProof: true,
                cookie: false,
            },
        ]);
    });
});
