/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { createHash } from "node:crypto";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import express, { type Response } from "express";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
    InvalidClientMetadataError,
    InvalidTargetError,
    InvalidRequestError,
    InvalidGrantError,
    InvalidTokenError,
    InvalidScopeError,
    InsufficientScopeError,
    OAuthError,
    TemporarilyUnavailableError,
    InvalidClientError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

import { LocalOAuthProvider } from "./LocalOAuthProvider.ts";

const resource = new URL("http://127.0.0.1:4199/mcp");

function client(id = "client-a"): OAuthClientInformationFull {
    return {
        client_id: id,
        client_name: `Synthetic ${id}`,
        redirect_uris: ["http://127.0.0.1:4200/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
    };
}

function scenario() {
    let time = 1000;
    const a = client();
    const b = client("client-b");
    const provider = new LocalOAuthProvider({
        resource: new URL(resource),
        clients: [a, b],
        now: () => time,
        accessTtlSeconds: 10,
        refreshTtlSeconds: 100,
        requestTtlSeconds: 20,
    });
    provider.setGrant("alice", a.client_id, ["read", "write"]);
    provider.setGrant("bob", a.client_id, ["read"]);
    provider.setGrant("alice", b.client_id, ["read"]);
    provider.setGrant("bob", b.client_id, ["read", "write"]);
    return {
        provider,
        a,
        b,
        advance: (seconds: number) => {
            time += seconds;
        },
    };
}

async function begin(provider: LocalOAuthProvider, registered = client(), change: Partial<AuthorizationParams> = {}) {
    const cookie = vi.fn();
    const redirect = vi.fn();
    const params: AuthorizationParams = {
        resource: new URL(resource),
        scopes: ["read"],
        redirectUri: registered.redirect_uris[0],
        codeChallenge: "A".repeat(43),
        state: "synthetic-state",
        ...change,
    };
    // Only the Express output adapter is replaced; OAuth state and transitions are real.
    await provider.authorize(registered, params, { cookie, redirect } as unknown as Response);
    const requestId = new URL(redirect.mock.calls[0][0], "http://127.0.0.1").searchParams.get("request")!;
    const cookieValue = cookie.mock.calls[0][1] as string;
    const consent = provider.describeConsent(requestId, cookieValue);
    return {
        requestId,
        cookie: cookieValue,
        csrf: consent.csrf,
        consent,
        cookieOptions: cookie.mock.calls[0][2],
        params,
    };
}

async function issueCode(provider: LocalOAuthProvider, registered = client(), userId = "alice", scopes = ["read"]) {
    const pending = await begin(provider, registered, { scopes });
    return new URL(provider.completeConsent(pending.requestId, pending.cookie, pending.csrf, userId)).searchParams.get(
        "code",
    )!;
}

async function issueTokens(provider: LocalOAuthProvider, registered = client(), userId = "alice", scopes = ["read"]) {
    const code = await issueCode(provider, registered, userId, scopes);
    return provider.exchangeAuthorizationCode(
        registered,
        code,
        undefined,
        registered.redirect_uris[0],
        new URL(resource),
    );
}

describe("LocalOAuthProvider", () => {
    it("uses the real SDK router for S256 PKCE and rejects plain challenges or a wrong verifier", async () => {
        const { provider, a } = scenario();
        const app = express();
        app.use("/authorize", authorizationHandler({ provider, rateLimit: false }));
        app.use("/token", tokenHandler({ provider, rateLimit: false }));
        const server = app.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected ephemeral loopback port");
        const origin = `http://127.0.0.1:${address.port}`;
        try {
            const verifier = "synthetic-verifier-".repeat(4);
            const challenge = createHash("sha256").update(verifier).digest("base64url");
            const query = new URLSearchParams({
                response_type: "code",
                client_id: a.client_id,
                redirect_uri: a.redirect_uris[0],
                scope: "read",
                code_challenge: challenge,
                code_challenge_method: "plain",
                resource: resource.href,
            });
            const plain = await fetch(`${origin}/authorize?${query}`, { redirect: "manual" });
            expect(plain.status).not.toBe(200);
            expect(plain.headers.get("set-cookie")).toBeNull();
            query.set("code_challenge_method", "S256");
            const authorization = await fetch(`${origin}/authorize?${query}`, { redirect: "manual" });
            expect(authorization.status).toBe(302);
            const cookie = authorization.headers.get("set-cookie")!;
            expect(cookie.includes("HttpOnly")).toBe(true);
            expect(cookie.includes("SameSite=Strict")).toBe(true);
            expect(cookie.includes("Path=/consent")).toBe(true);
            const cookieValue = /^infra_consent=([^;]+)/.exec(cookie)![1];
            const requestId = new URL(authorization.headers.get("location")!, origin).searchParams.get("request")!;
            const { csrf } = provider.describeConsent(requestId, cookieValue);
            const code = new URL(provider.completeConsent(requestId, cookieValue, csrf, "alice")).searchParams.get(
                "code",
            )!;
            const body = new URLSearchParams({
                grant_type: "authorization_code",
                client_id: a.client_id,
                code,
                code_verifier: "wrong-verifier-".repeat(4),
                redirect_uri: a.redirect_uris[0],
                resource: resource.href,
            });
            const wrong = await fetch(`${origin}/token`, { method: "POST", body });
            expect(wrong.status).toBe(400);
            expect((await wrong.json()).error).toBe("invalid_grant");
            body.set("code_verifier", verifier);
            const correct = await fetch(`${origin}/token`, { method: "POST", body });
            expect(correct.status).toBe(200);
            const tokens = await correct.json();
            expect(provider.assertCurrentAccess(tokens.access_token).extra).toEqual({ userId: "alice" });
            const replay = await fetch(`${origin}/token`, { method: "POST", body });
            expect(replay.status).toBe(400);
        } finally {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
                server.closeAllConnections();
            });
        }
    });

    it("copies trusted grant arrays and rejects invalid grant subjects or scope syntax", async () => {
        const { provider, a } = scenario();
        const scopes = ["read"];
        provider.setGrant("alice", a.client_id, scopes);
        provider.setGrant("bob", a.client_id, ["write"]);
        scopes.push("write");
        const pending = await begin(provider, a, { scopes: ["write"] });
        expect(() => provider.completeConsent(pending.requestId, pending.cookie, pending.csrf, "alice")).toThrow(
            InvalidScopeError,
        );
        expect(() => provider.setGrant("alice", "unknown", ["read"])).toThrow(InvalidClientError);
        expect(() => provider.setGrant("", a.client_id, ["read"])).toThrow(InvalidClientError);
        expect(() => provider.setGrant("alice", a.client_id, ["read write"])).toThrow(InvalidScopeError);
    });

    it("does not mix browser cookies or CSRF between pending requests", async () => {
        const { provider } = scenario();
        const first = await begin(provider);
        const second = await begin(provider);
        expect(first.cookie === second.cookie).toBe(false);
        expect(() => provider.describeConsent(first.requestId, second.cookie)).toThrow(InvalidRequestError);
        expect(() => provider.completeConsent(first.requestId, first.cookie, second.csrf, "alice")).toThrow(
            InvalidRequestError,
        );
    });

    it("bounds pending memory and reclaims expired requests rather than evicting live consent", async () => {
        const { provider, advance } = scenario();
        const first = await begin(provider);
        for (let i = 1; i < 1000; i++) await begin(provider);
        await expect(begin(provider)).rejects.toThrow(TemporarilyUnavailableError);
        expect(provider.describeConsent(first.requestId, first.cookie).scopes).toEqual(["read"]);
        advance(20);
        await expect(begin(provider)).resolves.toBeDefined();
    });

    it("bounds code memory and reclaims expired codes", async () => {
        const { provider, advance } = scenario();
        for (let i = 0; i < 1000; i++) await issueCode(provider);
        const pending = await begin(provider);
        expect(() => provider.completeConsent(pending.requestId, pending.cookie, pending.csrf, "alice")).toThrow(
            TemporarilyUnavailableError,
        );
        advance(20);
        await expect(issueCode(provider)).resolves.toBeDefined();
    });

    it("bounds refresh replay history without losing live replay detection", async () => {
        const { provider, a, advance } = scenario();
        let tokens = await issueTokens(provider);
        const original = tokens;
        for (let i = 1; i < 1000; i++)
            tokens = await provider.exchangeRefreshToken(a, tokens.refresh_token!, undefined, new URL(resource));
        await expect(
            provider.exchangeRefreshToken(a, tokens.refresh_token!, undefined, new URL(resource)),
        ).rejects.toThrow(TemporarilyUnavailableError);
        await expect(
            provider.exchangeRefreshToken(a, original.refresh_token!, undefined, new URL(resource)),
        ).rejects.toThrow(InvalidGrantError);
        expect(() => provider.assertCurrentAccess(tokens.access_token)).toThrow(InvalidTokenError);
        advance(100);
        await expect(issueTokens(provider)).resolves.toBeDefined();
    });

    it("bounds trusted grant entries while permitting replacement and removal", () => {
        const provider = new LocalOAuthProvider({ resource, clients: [client()] });
        for (let i = 0; i < 1000; i++) provider.setGrant(`synthetic-${i}`, "client-a", ["read"]);
        expect(() => provider.setGrant("overflow", "client-a", ["read"])).toThrow(TemporarilyUnavailableError);
        provider.setGrant("synthetic-0", "client-a", ["read", "write"]);
        provider.setGrant("synthetic-0", "client-a", []);
        expect(() => provider.setGrant("overflow", "client-a", ["read"])).not.toThrow();
    });

    it.each([NaN, Infinity, -1, 1.5, 1700000000000])("rejects clocks that are not epoch seconds: %s", (time) => {
        expect(() => new LocalOAuthProvider({ resource, clients: [client()], now: () => time })).toThrow(
            InvalidRequestError,
        );
    });

    it("fails closed if an injected clock becomes invalid", async () => {
        let time = 1000;
        const provider = new LocalOAuthProvider({ resource, clients: [client()], now: () => time });
        provider.setGrant("alice", "client-a", ["read"]);
        const tokens = await issueTokens(provider);
        time = NaN;
        expect(() => provider.assertCurrentAccess(tokens.access_token)).toThrow(InvalidRequestError);
    });

    it("uses integer epoch seconds by default and copies the resource option", async () => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(1000999);
        try {
            const configuredResource = new URL(resource);
            const provider = new LocalOAuthProvider({ resource: configuredResource, clients: [client()] });
            configuredResource.pathname = "/mutated";
            provider.setGrant("alice", "client-a", ["read"]);
            const tokens = await issueTokens(provider);
            expect(tokens.expires_in).toBe(60);
            expect(provider.assertCurrentAccess(tokens.access_token).expiresAt).toBe(
                Math.floor(Date.now() / 1000) + 60,
            );
            expect(provider.assertCurrentAccess(tokens.access_token).resource?.href).toBe(resource.href);
        } finally {
            clock.mockRestore();
        }
    });

    it.each([{ accessTtlSeconds: 301 }, { refreshTtlSeconds: 86401 }, { requestTtlSeconds: 301 }])(
        "enforces explicit upper TTL bounds %j",
        (change) => {
            expect(() => new LocalOAuthProvider({ resource, clients: [client()], ...change })).toThrow(
                InvalidRequestError,
            );
        },
    );

    it("asserts current access synchronously with an optional required scope", async () => {
        const { provider } = scenario();
        const tokens = await issueTokens(provider);
        const info = provider.assertCurrentAccess(tokens.access_token, "read");
        expect(info).not.toBeInstanceOf(Promise);
        expect(info.scopes).toEqual(["read"]);
        expect(() => provider.assertCurrentAccess(tokens.access_token, "write")).toThrow(InsufficientScopeError);
        expect(() => provider.assertCurrentAccess(tokens.access_token, "")).toThrow(InsufficientScopeError);
        expect(() => provider.assertCurrentAccess("unknown-token")).toThrow(InvalidTokenError);
        info.scopes.push("write");
        expect(() => provider.assertCurrentAccess(tokens.access_token, "write")).toThrow(InsufficientScopeError);
        expect(await provider.verifyAccessToken(tokens.access_token)).toEqual(
            provider.assertCurrentAccess(tokens.access_token),
        );
    });

    it("rejects a revoked family synchronously after an earlier async verification snapshot", async () => {
        const { provider, a } = scenario();
        const tokens = await issueTokens(provider);
        const snapshot = await provider.verifyAccessToken(tokens.access_token);
        const revocation = provider.revokeToken(a, { token: tokens.refresh_token! });
        expect(snapshot.scopes).toEqual(["read"]);
        expect(() => provider.assertCurrentAccess(tokens.access_token, "read")).toThrow(InvalidTokenError);
        await revocation;
        await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow(InvalidTokenError);
    });

    it("rechecks grant reductions and expiration without an async gap", async () => {
        const { provider, a, advance } = scenario();
        const tokens = await issueTokens(provider);
        await provider.verifyAccessToken(tokens.access_token);
        provider.setGrant("alice", a.client_id, []);
        expect(() => provider.assertCurrentAccess(tokens.access_token, "read")).toThrow(InvalidTokenError);
        provider.setGrant("alice", a.client_id, ["read", "write"]);
        const fresh = await issueTokens(provider);
        advance(10);
        expect(() => provider.assertCurrentAccess(fresh.access_token)).toThrow(InvalidTokenError);
    });

    it("rotates refresh tokens and revokes only that family on same-client replay", async () => {
        const { provider, a, b } = scenario();
        const original = await issueTokens(provider);
        const sibling = await issueTokens(provider);
        const otherClient = await issueTokens(provider, b, "bob", ["write"]);
        const bob = await issueTokens(provider, a, "bob");
        const rotated = await provider.exchangeRefreshToken(a, original.refresh_token!, undefined, new URL(resource));
        expect(rotated.refresh_token === original.refresh_token).toBe(false);
        expect((await provider.verifyAccessToken(original.access_token)).extra).toEqual({ userId: "alice" });
        await expect(
            provider.exchangeRefreshToken(a, original.refresh_token!, undefined, new URL(resource)),
        ).rejects.toThrow(InvalidGrantError);
        for (const token of [original.access_token, rotated.access_token])
            await expect(provider.verifyAccessToken(token)).rejects.toThrow(InvalidTokenError);
        await expect(
            provider.exchangeRefreshToken(a, rotated.refresh_token!, undefined, new URL(resource)),
        ).rejects.toThrow(InvalidGrantError);
        for (const token of [sibling.access_token, otherClient.access_token, bob.access_token])
            await expect(provider.verifyAccessToken(token)).resolves.toBeDefined();
    });

    it("does not let another client invalidate an unused or already-used refresh token", async () => {
        const { provider, a, b } = scenario();
        const tokens = await issueTokens(provider);
        await expect(
            provider.exchangeRefreshToken(b, tokens.refresh_token!, undefined, new URL(resource)),
        ).rejects.toThrow(InvalidGrantError);
        await provider.verifyAccessToken(tokens.access_token);
        const rotated = await provider.exchangeRefreshToken(a, tokens.refresh_token!, undefined, new URL(resource));
        await expect(
            provider.exchangeRefreshToken(b, tokens.refresh_token!, undefined, new URL(resource)),
        ).rejects.toThrow(InvalidGrantError);
        await expect(provider.verifyAccessToken(rotated.access_token)).resolves.toBeDefined();
    });

    it("requires the exact resource and never enlarges refresh scopes beyond the original token", async () => {
        const { provider, a } = scenario();
        const tokens = await issueTokens(provider);
        provider.setGrant("alice", a.client_id, ["read", "write", "admin"]);
        await expect(provider.exchangeRefreshToken(a, tokens.refresh_token!)).rejects.toThrow(InvalidTargetError);
        await expect(
            provider.exchangeRefreshToken(a, tokens.refresh_token!, undefined, new URL("http://127.0.0.1:4199/wrong")),
        ).rejects.toThrow(InvalidTargetError);
        await expect(
            provider.exchangeRefreshToken(a, tokens.refresh_token!, ["write"], new URL(resource)),
        ).rejects.toThrow(InvalidScopeError);
        await expect(provider.exchangeRefreshToken(a, tokens.refresh_token!, [], new URL(resource))).rejects.toThrow(
            InvalidScopeError,
        );
        const rotated = await provider.exchangeRefreshToken(a, tokens.refresh_token!, undefined, new URL(resource));
        expect(rotated.scope).toBe("read");
        expect((await provider.verifyAccessToken(rotated.access_token)).scopes).toEqual(["read"]);
    });

    it("copies downscoped refresh input and keeps subsequent rotations downscoped", async () => {
        const { provider, a } = scenario();
        const tokens = await issueTokens(provider, a, "alice", ["read", "write"]);
        const requested = ["read"];
        const rotated = await provider.exchangeRefreshToken(a, tokens.refresh_token!, requested, new URL(resource));
        requested.push("write");
        expect((await provider.verifyAccessToken(rotated.access_token)).scopes).toEqual(["read"]);
        await expect(
            provider.exchangeRefreshToken(a, rotated.refresh_token!, ["write"], new URL(resource)),
        ).rejects.toThrow(InvalidScopeError);
    });

    it("blocks refresh when the grant is reduced, even if the requested subset is still granted", async () => {
        const { provider, a } = scenario();
        const tokens = await issueTokens(provider, a, "alice", ["read", "write"]);
        provider.setGrant("alice", a.client_id, ["read"]);
        await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow(InvalidTokenError);
        await expect(
            provider.exchangeRefreshToken(a, tokens.refresh_token!, ["read"], new URL(resource)),
        ).rejects.toThrow(InvalidGrantError);
    });

    it("keeps a fixed refresh-family deadline across rotations", async () => {
        const { provider, a, advance } = scenario();
        const tokens = await issueTokens(provider);
        advance(99);
        const rotated = await provider.exchangeRefreshToken(a, tokens.refresh_token!, undefined, new URL(resource));
        expect(rotated.expires_in).toBe(1);
        advance(1);
        await expect(
            provider.exchangeRefreshToken(a, rotated.refresh_token!, undefined, new URL(resource)),
        ).rejects.toThrow(InvalidGrantError);
        await expect(provider.verifyAccessToken(rotated.access_token)).rejects.toThrow(InvalidTokenError);
    });

    it.each(["access_token", "refresh_token"] as const)(
        "revokes only the matching client family using %s",
        async (key) => {
            const { provider, a, b } = scenario();
            const tokens = await issueTokens(provider);
            const sibling = await issueTokens(provider);
            await provider.revokeToken(b, { token: tokens[key]! });
            await expect(provider.verifyAccessToken(tokens.access_token)).resolves.toBeDefined();
            await provider.revokeToken(a, { token: "unknown" });
            await provider.revokeToken(a, { token: tokens[key]! });
            await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow(InvalidTokenError);
            await expect(
                provider.exchangeRefreshToken(a, tokens.refresh_token!, undefined, new URL(resource)),
            ).rejects.toThrow(InvalidGrantError);
            await expect(provider.verifyAccessToken(sibling.access_token)).resolves.toBeDefined();
        },
    );

    it("exchanges a bound code once without requiring the verifier already consumed by the SDK", async () => {
        const { provider, a, b } = scenario();
        const code = await issueCode(provider);
        await expect(provider.challengeForAuthorizationCode(b, code)).rejects.toThrow(InvalidGrantError);
        expect(await provider.challengeForAuthorizationCode(a, code)).toBe("A".repeat(43));
        await expect(
            provider.exchangeAuthorizationCode(b, code, undefined, a.redirect_uris[0], new URL(resource)),
        ).rejects.toThrow(InvalidGrantError);
        await expect(
            provider.exchangeAuthorizationCode(a, code, undefined, undefined, new URL(resource)),
        ).rejects.toThrow(InvalidGrantError);
        await expect(
            provider.exchangeAuthorizationCode(a, code, undefined, `${a.redirect_uris[0]}/`, new URL(resource)),
        ).rejects.toThrow(InvalidGrantError);
        await expect(provider.exchangeAuthorizationCode(a, code, undefined, a.redirect_uris[0])).rejects.toThrow(
            InvalidTargetError,
        );
        await expect(
            provider.exchangeAuthorizationCode(
                a,
                code,
                undefined,
                a.redirect_uris[0],
                new URL("http://127.0.0.1:4199/wrong"),
            ),
        ).rejects.toThrow(InvalidTargetError);
        const tokens = await provider.exchangeAuthorizationCode(
            a,
            code,
            undefined,
            a.redirect_uris[0],
            new URL(resource),
        );
        expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 10, scope: "read" });
        expect(tokens.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(tokens.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(tokens.access_token === tokens.refresh_token).toBe(false);
        const info = await provider.verifyAccessToken(tokens.access_token);
        expect(info).toMatchObject({
            token: tokens.access_token,
            clientId: a.client_id,
            scopes: ["read"],
            expiresAt: 1010,
            extra: { userId: "alice" },
        });
        expect(info.resource?.href).toBe(resource.href);
        info.scopes.push("write");
        info.resource!.pathname = "/mutated";
        info.extra!.userId = "mallory";
        expect((await provider.verifyAccessToken(tokens.access_token)).scopes).toEqual(["read"]);
        expect((await provider.verifyAccessToken(tokens.access_token)).extra).toEqual({ userId: "alice" });
        expect((await provider.verifyAccessToken(tokens.access_token)).resource?.href).toBe(resource.href);
        await expect(
            provider.exchangeAuthorizationCode(a, code, undefined, a.redirect_uris[0], new URL(resource)),
        ).rejects.toThrow(InvalidGrantError);
        await expect(provider.challengeForAuthorizationCode(a, code)).rejects.toThrow(InvalidGrantError);
    });

    it("consumes an authorization code atomically across racing exchanges", async () => {
        const { provider, a } = scenario();
        const code = await issueCode(provider);
        const results = await Promise.allSettled(
            [1, 2].map(() =>
                provider.exchangeAuthorizationCode(a, code, undefined, a.redirect_uris[0], new URL(resource)),
            ),
        );
        expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    });

    it("expires codes and access tokens at exact deadlines", async () => {
        const { provider, a, advance } = scenario();
        const code = await issueCode(provider);
        const tokens = await issueTokens(provider);
        advance(10);
        await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow(InvalidTokenError);
        advance(10);
        await expect(provider.challengeForAuthorizationCode(a, code)).rejects.toThrow(InvalidGrantError);
        await expect(
            provider.exchangeAuthorizationCode(a, code, undefined, a.redirect_uris[0], new URL(resource)),
        ).rejects.toThrow(InvalidGrantError);
        await expect(provider.verifyAccessToken("unknown-token")).rejects.toThrow(InvalidTokenError);
    });

    it("rechecks current grants for codes and access without expanding issued scopes", async () => {
        const { provider, a } = scenario();
        const code = await issueCode(provider, a, "alice", ["write"]);
        const tokens = await issueTokens(provider);
        provider.setGrant("alice", a.client_id, ["read"]);
        await expect(provider.challengeForAuthorizationCode(a, code)).rejects.toThrow(InvalidGrantError);
        await expect(
            provider.exchangeAuthorizationCode(a, code, undefined, a.redirect_uris[0], new URL(resource)),
        ).rejects.toThrow(InvalidGrantError);
        provider.setGrant("alice", a.client_id, ["read", "write", "admin"]);
        expect((await provider.verifyAccessToken(tokens.access_token)).scopes).toEqual(["read"]);
        provider.setGrant("alice", a.client_id, []);
        await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow(InvalidTokenError);
    });

    it("requires independent consent nonce, cookie and CSRF before issuing a single-use code", async () => {
        const { provider, a } = scenario();
        const pending = await begin(provider, a);
        expect(pending.consent).toMatchObject({ clientName: "Synthetic client-a", scopes: ["read"] });
        expect(pending.cookieOptions).toMatchObject({
            httpOnly: true,
            sameSite: "strict",
            path: "/consent",
            maxAge: 20000,
        });
        for (const nonce of [pending.requestId, pending.cookie, pending.csrf])
            expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(new Set([pending.requestId, pending.cookie, pending.csrf]).size).toBe(3);
        expect(() => provider.describeConsent(pending.requestId, "wrong-cookie")).toThrow(InvalidRequestError);
        expect(() => provider.assertConsent(pending.requestId, pending.cookie, "wrong-csrf")).toThrow(
            InvalidRequestError,
        );
        expect(() => provider.completeConsent(pending.requestId, "wrong-cookie", pending.csrf, "alice")).toThrow(
            InvalidRequestError,
        );
        expect(() => provider.completeConsent(pending.requestId, pending.cookie, "wrong-csrf", "alice")).toThrow(
            InvalidRequestError,
        );
        provider.assertConsent(pending.requestId, pending.cookie, pending.csrf);
        pending.consent.scopes.push("write");
        pending.params.scopes!.push("write");
        pending.params.resource!.pathname = "/changed";
        expect(provider.describeConsent(pending.requestId, pending.cookie).scopes).toEqual(["read"]);
        const redirect = new URL(provider.completeConsent(pending.requestId, pending.cookie, pending.csrf, "alice"));
        expect(redirect.origin + redirect.pathname).toBe(a.redirect_uris[0]);
        expect(redirect.searchParams.get("state")).toBe("synthetic-state");
        expect(redirect.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(() => provider.completeConsent(pending.requestId, pending.cookie, pending.csrf, "alice")).toThrow(
            InvalidRequestError,
        );
    });

    it("never treats requested scopes as a grant for another user or client", async () => {
        const { provider, a, b } = scenario();
        const pending = await begin(provider, a, { scopes: ["write"] });
        expect(() => provider.completeConsent(pending.requestId, pending.cookie, pending.csrf, "bob")).toThrow(
            InvalidScopeError,
        );
        expect(() =>
            provider.completeConsent(pending.requestId, pending.cookie, pending.csrf, "unproven-user"),
        ).toThrow(InvalidScopeError);
        const other = await begin(provider, b, { scopes: ["write"] });
        expect(() => provider.completeConsent(other.requestId, other.cookie, other.csrf, "alice")).toThrow(
            InvalidScopeError,
        );
        expect(
            new URL(provider.completeConsent(other.requestId, other.cookie, other.csrf, "bob")).searchParams.has(
                "code",
            ),
        ).toBe(true);
    });

    it("denies consent with state and consumes the request", async () => {
        const { provider } = scenario();
        const pending = await begin(provider);
        expect(() => provider.denyConsent(pending.requestId, pending.cookie, "wrong")).toThrow(InvalidRequestError);
        const redirect = new URL(provider.denyConsent(pending.requestId, pending.cookie, pending.csrf));
        expect(redirect.searchParams.get("error")).toBe("access_denied");
        expect(redirect.searchParams.get("state")).toBe("synthetic-state");
        expect(redirect.searchParams.has("code")).toBe(false);
        expect(() => provider.describeConsent(pending.requestId, pending.cookie)).toThrow(InvalidRequestError);
    });

    it("expires pending consent exactly at the configured deadline", async () => {
        const { provider, advance } = scenario();
        const pending = await begin(provider);
        advance(20);
        expect(() => provider.describeConsent(pending.requestId, pending.cookie)).toThrow(InvalidRequestError);
        expect(() => provider.completeConsent(pending.requestId, pending.cookie, pending.csrf, "alice")).toThrow(
            InvalidRequestError,
        );
    });

    it.each([
        { resource: undefined },
        { resource: new URL("http://127.0.0.1:4199/other") },
        { scopes: [] },
        { scopes: undefined },
        { scopes: ["not-granted-anywhere"] },
        { scopes: ["read write"] },
        { redirectUri: "http://127.0.0.1:4200/callback/" },
        { redirectUri: "https://attacker.invalid/cb" },
        { codeChallenge: "plain-verifier" },
    ])("fails closed before redirecting an invalid authorization %j", async (change) => {
        const { provider, a } = scenario();
        await expect(begin(provider, a, change)).rejects.toThrow(OAuthError);
    });

    it("refuses unknown clients even with valid-looking metadata", async () => {
        const { provider } = scenario();
        await expect(begin(provider, client("unregistered"))).rejects.toThrow(OAuthError);
    });

    it.each([
        { token_endpoint_auth_method: "client_secret_post" },
        { token_endpoint_auth_method: undefined },
        { client_secret: "synthetic-not-a-real-secret" },
        { client_id: "" },
        { redirect_uris: [] },
        ...[
            "http://example.invalid/callback",
            "https://user:pass@example.invalid/cb",
            "https://@example.invalid/cb",
            "https://example.invalid/cb#x",
            "file:///cb",
            "not-url",
        ].map((redirect) => ({ redirect_uris: [redirect] })),
    ])("rejects unsafe public-client registration %j", (change) => {
        expect(() => new LocalOAuthProvider({ resource, clients: [{ ...client(), ...change }] })).toThrow(
            InvalidClientMetadataError,
        );
    });

    it.each(["https://example.invalid/cb", "http://localhost:4200/cb", "http://[::1]:4200/cb"])(
        "accepts a safe preregistered redirect %s",
        async (redirect) => {
            const provider = new LocalOAuthProvider({
                resource,
                clients: [{ ...client(), redirect_uris: [redirect] }],
            });
            expect((await provider.clientsStore.getClient("client-a"))?.redirect_uris).toEqual([redirect]);
        },
    );

    it("rejects duplicate registrations", () => {
        expect(() => new LocalOAuthProvider({ resource, clients: [client(), client()] })).toThrow(
            InvalidClientMetadataError,
        );
    });

    it.each([0, -1, 1.5, NaN, Infinity, 300001])("rejects invalid TTL seconds %s", (ttl) => {
        for (const key of ["accessTtlSeconds", "refreshTtlSeconds", "requestTtlSeconds"]) {
            expect(() => new LocalOAuthProvider({ resource, clients: [client()], [key]: ttl })).toThrow(
                InvalidRequestError,
            );
        }
    });

    it("rejects unsafe resource identifiers", () => {
        for (const value of [
            "http://remote.invalid/mcp",
            "https://u:p@example.invalid/mcp",
            "https://example.invalid/mcp#x",
        ]) {
            expect(() => new LocalOAuthProvider({ resource: new URL(value), clients: [client()] })).toThrow(
                InvalidTargetError,
            );
        }
    });

    it("exposes only preregistered clients through a defensive read-only store", async () => {
        const registered = client();
        const provider = new LocalOAuthProvider({ resource, clients: [registered] });
        registered.redirect_uris.push("https://attacker.invalid/callback");
        registered.client_name = "changed";
        const first = await provider.clientsStore.getClient("client-a");
        expect(first?.client_name).toBe("Synthetic client-a");
        expect(first?.redirect_uris).toEqual(["http://127.0.0.1:4200/callback"]);
        first!.redirect_uris.length = 0;
        expect((await provider.clientsStore.getClient("client-a"))?.redirect_uris).toHaveLength(1);
        expect(await provider.clientsStore.getClient("unknown")).toBeUndefined();
        expect(Object.keys(provider.clientsStore)).toEqual(["getClient"]);
    });
});
