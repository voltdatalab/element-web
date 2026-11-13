/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createInfraMcpApp } from "./infraMcpApp.ts";
import { LocalOAuthProvider } from "./LocalOAuthProvider.ts";
import type { ConsentProvider } from "./ConsentProvider.ts";

function unused(): never {
    throw new Error("unexpected_call");
}

function fixtureProvider(): ConsentProvider {
    return {
        clientsStore: { getClient: () => undefined },
        authorize: unused,
        challengeForAuthorizationCode: unused,
        exchangeAuthorizationCode: unused,
        exchangeRefreshToken: unused,
        verifyAccessToken: async () => {
            throw new InvalidTokenError("invalid_token");
        },
        assertCurrentAccess: () => {
            throw new InvalidTokenError("invalid_token");
        },
        describeConsent: unused,
        assertConsent: unused,
        completeConsent: unused,
        denyConsent: unused,
    };
}

async function serve(provider: ConsentProvider | ((baseUrl: URL) => ConsentProvider) = fixtureProvider()) {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const baseUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    try {
        if (typeof provider === "function") provider = provider(baseUrl);
        const verifier = { verify: vi.fn(async () => "@demo:example.test") };
        const readStatus = vi.fn(async (application: string, environment: string) => ({
            application,
            environment,
            healthy: true,
            version: "fixture-v1",
        }));
        server.on("request", createInfraMcpApp({ baseUrl, provider, verifier, readStatus }));
        return {
            baseUrl,
            provider,
            verifier,
            readStatus,
            close: async () => {
                server.closeAllConnections();
                await new Promise<void>((resolve) => server.close(() => resolve()));
            },
        };
    } catch (error) {
        server.close();
        throw error;
    }
}

const clientId = "http-client-fixture";
const redirectUri = "http://127.0.0.1:34567/callback";
const scope = "infra:read:demo-app:staging";

function authorizationProvider(baseUrl: URL): LocalOAuthProvider {
    const provider = new LocalOAuthProvider({
        resource: new URL("/mcp", baseUrl),
        clients: [{ client_id: clientId, redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }],
    });
    provider.setGrant("@demo:example.test", clientId, [scope]);
    return provider;
}

function authorizationParams(baseUrl: URL): URLSearchParams {
    return new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        resource: new URL("/mcp", baseUrl).href,
        scope,
        state: "http-state-fixture",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update("x".repeat(43)).digest("base64url"),
    });
}

function authorize(baseUrl: URL, method: string, params: URLSearchParams): Promise<Response> {
    return fetch(new URL(method === "POST" ? "/authorize" : `/authorize?${params}`, baseUrl), {
        method,
        redirect: "manual",
        ...(method === "POST" ? { body: params } : {}),
    });
}

describe("MCP loopback HTTP boundary", () => {
    describe.each(["GET", "POST"])("%s authorization redirect boundary", (method) => {
        it.each(["S256", "plain"])("rejects a changed loopback port before %s PKCE validation", async (pkce) => {
            const f = await serve(authorizationProvider);
            const authorization = vi.spyOn(f.provider, "authorize");
            try {
                const params = authorizationParams(f.baseUrl);
                params.set("redirect_uri", "http://127.0.0.1:34568/callback");
                params.set("code_challenge_method", pkce);
                const response = await authorize(f.baseUrl, method, params);
                expect(response.status).toBe(400);
                expect(response.headers.get("content-type")).toContain("application/json");
                expect(response.headers.get("location")).toBeNull();
                expect(response.headers.get("set-cookie")).toBeNull();
                expect(await response.json()).toEqual({ error: "invalid_request" });
                expect(authorization).not.toHaveBeenCalled();
            } finally {
                await f.close();
            }
        });

        it.each([
            "http://localhost:34567/callback",
            "http://127.0.0.1:34567/another-callback",
            "http://127.0.0.1:34567/callback?extra=value",
            "http://127.0.0.1:34567/callback#fragment",
            "http://user@127.0.0.1:34567/callback",
            "HTTP://127.0.0.1:34567/callback",
            "http://127.0.0.1:34567/extra/../callback",
            " http://127.0.0.1:34567/callback",
            "http:/127.0.0.1:34567/callback",
            "http://127.0.0.1:34567\\callback",
            "/callback",
            "not-a-url",
        ])("rejects a nonliteral callback without URL repair: %s", async (callback) => {
            const f = await serve(authorizationProvider);
            const authorization = vi.spyOn(f.provider, "authorize");
            try {
                const params = authorizationParams(f.baseUrl);
                params.set("redirect_uri", callback);
                const response = await authorize(f.baseUrl, method, params);
                expect(response.status).toBe(400);
                expect(response.headers.get("location")).toBeNull();
                expect(response.headers.get("set-cookie")).toBeNull();
                expect(await response.json()).toEqual({ error: "invalid_request" });
                expect(authorization).not.toHaveBeenCalled();
            } finally {
                await f.close();
            }
        });

        it.each(["client_id", "redirect_uri"])("rejects a missing %s without a redirect", async (field) => {
            const f = await serve(authorizationProvider);
            const authorization = vi.spyOn(f.provider, "authorize");
            try {
                const params = authorizationParams(f.baseUrl);
                params.delete(field);
                const response = await authorize(f.baseUrl, method, params);
                expect(response.status).toBe(400);
                expect(response.headers.get("location")).toBeNull();
                expect(response.headers.get("set-cookie")).toBeNull();
                expect(await response.json()).toEqual({ error: "invalid_request" });
                expect(authorization).not.toHaveBeenCalled();
            } finally {
                await f.close();
            }
        });

        it.each(["client_id", "redirect_uri"])("rejects duplicate %s values without a redirect", async (field) => {
            const f = await serve(authorizationProvider);
            const authorization = vi.spyOn(f.provider, "authorize");
            try {
                const params = authorizationParams(f.baseUrl);
                params.append(field, params.get(field)!);
                const response = await authorize(f.baseUrl, method, params);
                expect(response.status).toBe(400);
                expect(response.headers.get("location")).toBeNull();
                expect(response.headers.get("set-cookie")).toBeNull();
                expect(await response.json()).toEqual({ error: "invalid_request" });
                expect(authorization).not.toHaveBeenCalled();
            } finally {
                await f.close();
            }
        });

        it.each(["unknown-client", `${clientId} `])("rejects an unknown literal client ID: %s", async (id) => {
            const f = await serve(authorizationProvider);
            const authorization = vi.spyOn(f.provider, "authorize");
            try {
                const params = authorizationParams(f.baseUrl);
                params.set("client_id", id);
                const response = await authorize(f.baseUrl, method, params);
                expect(response.status).toBe(400);
                expect(response.headers.get("location")).toBeNull();
                expect(response.headers.get("set-cookie")).toBeNull();
                expect(await response.json()).toEqual({ error: "invalid_client" });
                expect(authorization).not.toHaveBeenCalled();
            } finally {
                await f.close();
            }
        });

        it("keeps consent issuance for the exact registered callback", async () => {
            const f = await serve(authorizationProvider);
            try {
                const response = await authorize(f.baseUrl, method, authorizationParams(f.baseUrl));
                expect(response.status).toBe(302);
                const cookie = response.headers.get("set-cookie");
                expect(cookie).toContain("infra_consent=");
                expect(cookie).toContain("HttpOnly");
                expect(cookie).toContain("SameSite=Strict");
                const location = new URL(response.headers.get("location")!, f.baseUrl);
                expect(location.origin).toBe(f.baseUrl.origin);
                expect(location.pathname).toBe("/consent");
                expect(location.searchParams.get("request")).toBeTruthy();
                expect(location.searchParams.has("code")).toBe(false);
                const consent = await fetch(location, { headers: { Cookie: cookie!.split(";")[0] } });
                expect(consent.status).toBe(200);
                expect(await consent.json()).toEqual({
                    clientName: clientId,
                    scopes: [scope],
                    csrf: expect.any(String),
                });
            } finally {
                await f.close();
            }
        });
    });

    it("does not trust a POST query over the urlencoded authorization body", async () => {
        const f = await serve(authorizationProvider);
        const authorization = vi.spyOn(f.provider, "authorize");
        try {
            const params = authorizationParams(f.baseUrl);
            const target = new URL(`/authorize?${params}`, f.baseUrl);
            params.set("redirect_uri", "http://127.0.0.1:34568/callback");
            const response = await fetch(target, { method: "POST", body: params, redirect: "manual" });
            expect(response.status).toBe(400);
            expect(response.headers.get("location")).toBeNull();
            expect(response.headers.get("set-cookie")).toBeNull();
            expect(await response.json()).toEqual({ error: "invalid_request" });
            expect(authorization).not.toHaveBeenCalled();
        } finally {
            await f.close();
        }
    });

    it("bounds urlencoded authorization parsing before the SDK", async () => {
        const f = await serve(authorizationProvider);
        const authorization = vi.spyOn(f.provider, "authorize");
        try {
            const params = authorizationParams(f.baseUrl);
            params.set("state", "x".repeat(5000));
            const response = await authorize(f.baseUrl, "POST", params);
            expect(response.status).toBe(400);
            expect(response.headers.get("location")).toBeNull();
            expect(response.headers.get("set-cookie")).toBeNull();
            expect(await response.json()).toEqual({ error: "invalid_request" });
            expect(authorization).not.toHaveBeenCalled();
        } finally {
            await f.close();
        }
    });

    it("rejects a foreign Host header without trusting the destination socket", async () => {
        const f = await serve();
        try {
            const status = await new Promise<number | undefined>((resolve, reject) => {
                const request = httpRequest(
                    new URL("/mcp", f.baseUrl),
                    { method: "POST", headers: { Host: "untrusted.example" } },
                    (response) => {
                        response.resume();
                        resolve(response.statusCode);
                    },
                );
                request.on("error", reject);
                request.end();
            });
            expect(status).toBe(403);
        } finally {
            await f.close();
        }
    });

    it("returns generic JSON for malformed request bodies", async () => {
        const f = await serve();
        try {
            const response = await fetch(new URL("/consent", f.baseUrl), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{ malformed-request-canary",
            });
            expect(response.status).toBe(400);
            expect(response.headers.get("content-type")).toContain("application/json");
            expect(await response.text()).not.toContain("malformed-request-canary");
        } finally {
            await f.close();
        }
    });

    it("refuses a non-loopback base URL", () => {
        expect(() =>
            createInfraMcpApp({
                baseUrl: new URL("https://remote.example"),
                provider: fixtureProvider(),
                verifier: { verify: unused },
                readStatus: unused,
            }),
        ).toThrow("loopback");
    });

    it("advertises protected resource metadata and refuses unauthenticated requests", async () => {
        const f = await serve();
        try {
            const metadata = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", f.baseUrl));
            expect(metadata.status).toBe(200);
            expect((await metadata.json()).resource).toBe(new URL("/mcp", f.baseUrl).href);
            const response = await fetch(new URL("/mcp", f.baseUrl), { method: "POST" });
            expect(response.status).toBe(401);
            expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
            expect(f.verifier.verify).not.toHaveBeenCalled();
            expect(f.readStatus).not.toHaveBeenCalled();
        } finally {
            await f.close();
        }
    });

    it("keeps the configured consent origin stable if the caller mutates its URL", async () => {
        const provider = fixtureProvider();
        provider.assertConsent = vi.fn();
        provider.completeConsent = vi.fn(() => "http://127.0.0.1:9999/callback?code=fixture");
        const f = await serve(provider);
        const original = new URL(f.baseUrl.href);
        f.baseUrl.hostname = "untrusted.example";
        try {
            const response = await fetch(new URL("/consent", original), {
                method: "POST",
                redirect: "manual",
                headers: {
                    Origin: original.origin,
                    Cookie: "infra_consent=fixture-cookie",
                    Authorization: "Bearer matrix-session-fixture",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ request: "fixture", csrf: "fixture", approve: true }),
            });
            expect(response.status).toBe(302);
        } finally {
            await f.close();
        }
    });

    it("returns browser-bound consent details without caching them", async () => {
        const provider = fixtureProvider();
        provider.describeConsent = vi.fn(() => ({
            clientName: "fixture-client",
            scopes: ["infra:read:demo-app:staging"],
            csrf: "csrf-fixture",
        }));
        const f = await serve(provider);
        try {
            const response = await fetch(new URL("/consent?request=request-fixture", f.baseUrl), {
                headers: { Cookie: "infra_consent=fixture-cookie" },
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
                clientName: "fixture-client",
                scopes: ["infra:read:demo-app:staging"],
                csrf: "csrf-fixture",
            });
            expect(response.headers.get("cache-control")).toBe("no-store");
            expect(provider.describeConsent).toHaveBeenCalledWith("request-fixture", "fixture-cookie");
        } finally {
            await f.close();
        }
    });

    it("uses a verified Matrix identity rather than a browser-supplied owner", async () => {
        const provider = fixtureProvider();
        provider.assertConsent = vi.fn();
        provider.completeConsent = vi.fn(() => "http://127.0.0.1:9999/callback?code=fixture-code");
        const f = await serve(provider);
        try {
            const response = await fetch(new URL("/consent", f.baseUrl), {
                method: "POST",
                redirect: "manual",
                headers: {
                    Origin: f.baseUrl.origin,
                    Cookie: "infra_consent=fixture-cookie",
                    Authorization: "Bearer matrix-session-fixture",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ request: "request-fixture", csrf: "csrf-fixture", approve: true }),
            });
            expect(response.status).toBe(302);
            expect(f.verifier.verify).toHaveBeenCalledWith("matrix-session-fixture");
            expect(provider.completeConsent).toHaveBeenCalledWith(
                "request-fixture",
                "fixture-cookie",
                "csrf-fixture",
                "@demo:example.test",
            );
            expect(response.headers.get("location")).not.toContain("matrix-session-fixture");
        } finally {
            await f.close();
        }
    });

    it("serves authorized status through a real MCP client and blocks another application", async () => {
        const provider = fixtureProvider();
        let resource: URL;
        provider.verifyAccessToken = async (token) => ({
            token,
            clientId: "client-fixture",
            scopes: ["infra:read:demo-app:staging"],
            expiresAt: Date.now() / 1000 + 60,
            resource,
            extra: { userId: "@demo:example.test" },
        });
        provider.assertCurrentAccess = (token, scope) => {
            if (scope && scope !== "infra:read:demo-app:staging") throw new InvalidTokenError("forbidden");
            return {
                token,
                clientId: "client-fixture",
                scopes: ["infra:read:demo-app:staging"],
                expiresAt: Date.now() / 1000 + 60,
                resource,
                extra: { userId: "@demo:example.test" },
            };
        };
        const f = await serve(provider);
        resource = new URL("/mcp", f.baseUrl);
        const client = new Client({ name: "real-sdk-test", version: "1.0.0" });
        try {
            await client.connect(
                new StreamableHTTPClientTransport(resource, {
                    requestInit: { headers: { Authorization: "Bearer mcp-fixture" } },
                }),
            );
            expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["infra_status"]);
            const answer = await client.callTool({
                name: "infra_status",
                arguments: { application: "demo-app", environment: "staging" },
            });
            expect(answer.isError).not.toBe(true);
            expect(JSON.stringify(answer.content)).toContain("fixture-v1");
            const denied = await client.callTool({
                name: "infra_status",
                arguments: { application: "other-app", environment: "staging" },
            });
            expect(denied.isError).toBe(true);
            expect(f.readStatus).toHaveBeenCalledTimes(1);
        } finally {
            await client.close();
            await f.close();
        }
    });

    it("blocks a result when access is revoked during the status read", async () => {
        const provider = fixtureProvider();
        let resource: URL;
        let active = true;
        const auth = (token: string) => {
            if (!active) throw new InvalidTokenError("revoked");
            return {
                token,
                clientId: "client-fixture",
                scopes: ["infra:read:demo-app:staging"],
                expiresAt: Date.now() / 1000 + 60,
                resource,
                extra: { userId: "@demo:example.test" },
            };
        };
        provider.verifyAccessToken = async (token) => auth(token);
        provider.assertCurrentAccess = (token) => auth(token);
        const f = await serve(provider);
        resource = new URL("/mcp", f.baseUrl);
        f.readStatus.mockImplementation(async () => {
            active = false;
            return { application: "demo-app", environment: "staging", healthy: true, version: "private-result-canary" };
        });
        const client = new Client({ name: "revocation-test", version: "1.0.0" });
        try {
            await client.connect(
                new StreamableHTTPClientTransport(resource, {
                    requestInit: { headers: { Authorization: "Bearer mcp-fixture" } },
                }),
            );
            const answer = await client.callTool({
                name: "infra_status",
                arguments: { application: "demo-app", environment: "staging" },
            });
            expect(answer.isError).toBe(true);
            expect(JSON.stringify(answer)).not.toContain("private-result-canary");
        } finally {
            await client.close();
            await f.close();
        }
    });

    it("refuses status data belonging to a different target", async () => {
        const provider = fixtureProvider();
        let resource: URL;
        provider.verifyAccessToken = async (token) => provider.assertCurrentAccess(token);
        provider.assertCurrentAccess = (token) => ({
            token,
            clientId: "fixture",
            scopes: ["infra:read:demo-app:staging"],
            expiresAt: Date.now() / 1000 + 60,
            resource,
        });
        const f = await serve(provider);
        resource = new URL("/mcp", f.baseUrl);
        f.readStatus.mockResolvedValue({
            application: "other-app",
            environment: "production",
            healthy: true,
            version: "wrong-target-canary",
        });
        const client = new Client({ name: "target-test", version: "1.0.0" });
        try {
            await client.connect(
                new StreamableHTTPClientTransport(resource, {
                    requestInit: { headers: { Authorization: "Bearer mcp-fixture" } },
                }),
            );
            const answer = await client.callTool({
                name: "infra_status",
                arguments: { application: "demo-app", environment: "staging" },
            });
            expect(answer.isError).toBe(true);
            expect(JSON.stringify(answer)).not.toContain("wrong-target-canary");
        } finally {
            await client.close();
            await f.close();
        }
    });

    it("rejects an untrusted browser origin before authentication", async () => {
        const provider = fixtureProvider();
        const verify = vi.spyOn(provider, "verifyAccessToken");
        const f = await serve(provider);
        try {
            const response = await fetch(new URL("/mcp", f.baseUrl), {
                method: "POST",
                headers: { Origin: "https://untrusted.example", Authorization: "Bearer fixture" },
            });
            expect(response.status).toBe(403);
            expect(verify).not.toHaveBeenCalled();
        } finally {
            await f.close();
        }
    });
});
