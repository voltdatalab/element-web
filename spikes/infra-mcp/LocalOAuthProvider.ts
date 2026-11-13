/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type {
    OAuthClientInformationFull,
    OAuthTokenRevocationRequest,
    OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
    InvalidClientMetadataError,
    InvalidTargetError,
    InvalidRequestError,
    InvalidClientError,
    InvalidScopeError,
    InvalidGrantError,
    InvalidTokenError,
    InsufficientScopeError,
    TemporarilyUnavailableError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

type Binding = { clientId: string; scopes: string[]; resource: string };
type Pending = Binding & {
    redirectUri: string;
    state?: string;
    challenge: string;
    expiresAt: number;
    cookieHash: string;
    csrf: string;
};
type Code = Binding & { userId: string; redirectUri: string; challenge: string; expiresAt: number };
type Token = Binding & { userId: string; familyId: string; expiresAt: number };
type Refresh = Token & { used: boolean };
type Family = { clientId: string; expiresAt: number; revoked: boolean };

function nonce(): string {
    return randomBytes(32).toString("base64url");
}

function hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function matches(value: string, expectedHash: string): boolean {
    return timingSafeEqual(Buffer.from(hash(value), "hex"), Buffer.from(expectedHash, "hex"));
}

function validScopes(scopes: readonly string[] | undefined, allowEmpty = false): scopes is string[] {
    return (
        Array.isArray(scopes) &&
        (allowEmpty || scopes.length > 0) &&
        scopes.length <= 32 &&
        scopes.every((scope) => typeof scope === "string" && /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/.test(scope))
    );
}

const capacity = 1000;

function safeUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return (
            value.length <= 2048 &&
            !url.username &&
            !url.password &&
            // URL parsing erases empty userinfo, so also check the original authority.
            !/^[a-z][a-z\d+.-]*:\/\/[^/?#]*@/i.test(value) &&
            !value.includes("#") &&
            (url.protocol === "https:" ||
                (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
        );
    } catch {
        return false;
    }
}

function ttl(value: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new InvalidRequestError("Invalid TTL seconds");
    return value;
}

/** In-memory OAuth provider for the isolated, synthetic MCP laboratory. */
export class LocalOAuthProvider implements OAuthServerProvider {
    private readonly clients = new Map<string, OAuthClientInformationFull>();
    private readonly grants = new Map<string, { clientId: string; scopes: Set<string> }>();
    private readonly pending = new Map<string, Pending>();
    private readonly codes = new Map<string, Code>();
    private readonly access = new Map<string, Token>();
    private readonly refresh = new Map<string, Refresh>();
    private readonly families = new Map<string, Family>();
    private readonly resource: string;
    private readonly now: () => number;
    private readonly accessTtl: number;
    private readonly refreshTtl: number;
    private readonly requestTtl: number;
    public readonly clientsStore: OAuthRegisteredClientsStore;

    public constructor(options: {
        resource: URL;
        clients: OAuthClientInformationFull[];
        now?: () => number;
        accessTtlSeconds?: number;
        refreshTtlSeconds?: number;
        requestTtlSeconds?: number;
    }) {
        if (!safeUrl(options.resource.href)) throw new InvalidTargetError("Invalid resource");
        this.resource = options.resource.href;
        const clock = options.now ?? (() => Math.floor(Date.now() / 1000));
        this.now = () => {
            const now = clock();
            // The year-9999 bound also catches accidentally supplied epoch milliseconds.
            if (!Number.isSafeInteger(now) || now < 0 || now > 253402300799)
                throw new InvalidRequestError("Invalid epoch seconds");
            return now;
        };
        this.now();
        this.accessTtl = ttl(options.accessTtlSeconds ?? 60, 300);
        this.refreshTtl = ttl(options.refreshTtlSeconds ?? 3600, 86400);
        this.requestTtl = ttl(options.requestTtlSeconds ?? 120, 300);
        if (options.clients.length > capacity) throw new InvalidClientMetadataError("Too many clients");
        for (const client of options.clients) {
            if (
                !client.client_id ||
                client.client_id.length > 256 ||
                this.clients.has(client.client_id) ||
                client.token_endpoint_auth_method !== "none" ||
                client.client_secret !== undefined ||
                !client.redirect_uris.length ||
                client.redirect_uris.length > 20 ||
                !client.redirect_uris.every(safeUrl)
            ) {
                throw new InvalidClientMetadataError("Invalid public client registration");
            }
            this.clients.set(client.client_id, structuredClone(client));
        }
        this.clientsStore = Object.freeze({
            getClient: (id: string) => {
                const client = this.clients.get(id);
                return client && structuredClone(client);
            },
        });
    }

    /** Replace a trusted, externally established user/client grant. This does not authenticate a user. */
    public setGrant(userId: string, clientId: string, scopes: readonly string[]): void {
        if (!userId || userId.length > 256 || !this.clients.has(clientId))
            throw new InvalidClientError("Invalid grant subject");
        if (!validScopes(scopes, true)) throw new InvalidScopeError("Invalid scopes");
        const key = JSON.stringify([userId, clientId]);
        if (scopes.length === 0) {
            this.grants.delete(key);
            return;
        }
        if (!this.grants.has(key) && this.grants.size >= capacity)
            throw new TemporarilyUnavailableError("Capacity reached");
        this.grants.set(key, { clientId, scopes: new Set(scopes) });
    }

    /** Begin consent without choosing or trusting a user from authorization input. */
    public async authorize(
        client: OAuthClientInformationFull,
        params: AuthorizationParams,
        res: Response,
    ): Promise<void> {
        const registered = this.registeredClient(client);
        this.requireResource(params.resource);
        if (!registered.redirect_uris.includes(params.redirectUri))
            throw new InvalidRequestError("Invalid redirect URI");
        if (!validScopes(params.scopes)) throw new InvalidScopeError("Invalid scopes");
        const catalog = new Set(
            [...this.grants.values()]
                .filter((grant) => grant.clientId === registered.client_id)
                .flatMap((grant) => [...grant.scopes]),
        );
        if (!params.scopes.every((scope) => catalog.has(scope))) throw new InvalidScopeError("Invalid scopes");
        if (
            !/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) ||
            (params.state !== undefined && params.state.length > 2048)
        ) {
            throw new InvalidRequestError("Invalid authorization request");
        }
        this.cleanup();
        if (this.pending.size >= capacity) throw new TemporarilyUnavailableError("Capacity reached");
        const requestId = nonce();
        const cookie = nonce();
        this.pending.set(hash(requestId), {
            clientId: registered.client_id,
            scopes: [...new Set(params.scopes)],
            resource: this.resource,
            redirectUri: params.redirectUri,
            state: params.state,
            challenge: params.codeChallenge,
            expiresAt: this.now() + this.requestTtl,
            cookieHash: hash(cookie),
            csrf: nonce(),
        });
        res.cookie("infra_consent", cookie, {
            httpOnly: true,
            sameSite: "strict",
            path: "/consent",
            maxAge: this.requestTtl * 1000,
            secure: new URL(this.resource).protocol === "https:",
        });
        res.redirect(`/consent?request=${requestId}`);
    }

    /** Read a pending request only with its bound browser cookie. */
    public describeConsent(requestId: string, cookie: string): { clientName: string; scopes: string[]; csrf: string } {
        const pending = this.consent(requestId, cookie);
        const client = this.clients.get(pending.clientId)!;
        return { clientName: client.client_name ?? client.client_id, scopes: [...pending.scopes], csrf: pending.csrf };
    }

    /** Validate the cookie-bound CSRF proof without consuming consent. */
    public assertConsent(requestId: string, cookie: string, csrf: string): void {
        const pending = this.consent(requestId, cookie);
        if (!matches(csrf, hash(pending.csrf))) throw new InvalidRequestError("Invalid consent request");
    }

    /** Consume consent only after checking the trusted user/client grant. */
    public completeConsent(requestId: string, cookie: string, csrf: string, userId: string): string {
        this.assertConsent(requestId, cookie, csrf);
        const pending = this.consent(requestId, cookie);
        if (!this.hasGrant(userId, pending)) throw new InvalidScopeError("Grant does not permit requested scopes");
        if (this.codes.size >= capacity) throw new TemporarilyUnavailableError("Capacity reached");
        const code = nonce();
        // No await between validation, consuming consent and issuing the code.
        this.pending.delete(hash(requestId));
        this.codes.set(hash(code), {
            clientId: pending.clientId,
            scopes: [...pending.scopes],
            resource: pending.resource,
            userId,
            redirectUri: pending.redirectUri,
            challenge: pending.challenge,
            expiresAt: this.now() + Math.min(60, this.requestTtl),
        });
        return this.consentRedirect(pending, "code", code);
    }

    /** Consume denied consent and preserve the caller's state. */
    public denyConsent(requestId: string, cookie: string, csrf: string): string {
        this.assertConsent(requestId, cookie, csrf);
        const pending = this.consent(requestId, cookie);
        this.pending.delete(hash(requestId));
        return this.consentRedirect(pending, "error", "access_denied");
    }

    /** Supply the S256 challenge to the SDK's local PKCE validator. */
    public async challengeForAuthorizationCode(
        client: OAuthClientInformationFull,
        authorizationCode: string,
    ): Promise<string> {
        return this.authorizationCode(client, authorizationCode).challenge;
    }

    /** Exchange only after the SDK has validated PKCE; a verifier is intentionally not required here. */
    public async exchangeAuthorizationCode(
        client: OAuthClientInformationFull,
        authorizationCode: string,
        _codeVerifier?: string,
        redirectUri?: string,
        resource?: URL,
    ): Promise<OAuthTokens> {
        this.requireResource(resource);
        const code = this.authorizationCode(client, authorizationCode);
        if (redirectUri !== code.redirectUri || code.resource !== resource!.href)
            throw new InvalidGrantError("Invalid authorization code");
        this.tokenCapacity(true);
        const familyId = nonce();
        const family = { clientId: code.clientId, expiresAt: this.now() + this.refreshTtl, revoked: false };
        this.codes.delete(hash(authorizationCode));
        this.families.set(familyId, family);
        return this.issue(code, familyId, family);
    }

    /** Rotate a refresh token once; keep used hashes until the fixed family deadline for replay detection. */
    public async exchangeRefreshToken(
        client: OAuthClientInformationFull,
        refreshToken: string,
        scopes?: string[],
        resource?: URL,
    ): Promise<OAuthTokens> {
        this.registeredClient(client);
        this.cleanup();
        const stored = this.refresh.get(hash(refreshToken));
        if (!stored || stored.clientId !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
        const family = this.families.get(stored.familyId);
        // A different client cannot burn this token or revoke its family.
        if (stored.used && family) family.revoked = true;
        if (!family || family.revoked || !this.hasGrant(stored.userId, stored))
            throw new InvalidGrantError("Invalid refresh token");
        this.requireResource(resource);
        const requested = scopes ?? stored.scopes;
        if (!validScopes(requested) || !requested.every((scope) => stored.scopes.includes(scope)))
            throw new InvalidScopeError("Invalid scopes");
        this.tokenCapacity(false);
        stored.used = true;
        return this.issue({ ...stored, scopes: [...new Set(requested)] }, stored.familyId, family);
    }

    /** Revoke only the family owned by this registered client; unknown tokens are a no-op. */
    public async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
        this.registeredClient(client);
        this.cleanup();
        const key = hash(request.token);
        const stored = this.access.get(key) ?? this.refresh.get(key);
        if (!stored || stored.clientId !== client.client_id) return;
        const family = this.families.get(stored.familyId);
        if (family) family.revoked = true;
    }

    /** Verify current validity rather than trusting an earlier authentication snapshot. */
    public async verifyAccessToken(token: string): Promise<AuthInfo> {
        return this.assertCurrentAccess(token);
    }

    /** Recheck immediately before delivering protected data, without yielding to another microtask. */
    public assertCurrentAccess(token: string, scope?: string): AuthInfo {
        this.cleanup();
        const stored = this.access.get(hash(token));
        const family = stored && this.families.get(stored.familyId);
        if (!stored || !family || family.revoked || !this.hasGrant(stored.userId, stored))
            throw new InvalidTokenError("Invalid access token");
        if (scope !== undefined && !stored.scopes.includes(scope))
            throw new InsufficientScopeError("Required scope not granted");
        return {
            token,
            clientId: stored.clientId,
            scopes: [...stored.scopes],
            expiresAt: stored.expiresAt,
            resource: new URL(stored.resource),
            extra: { userId: stored.userId },
        };
    }

    private authorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Code {
        this.registeredClient(client);
        this.cleanup();
        const code = this.codes.get(hash(authorizationCode));
        if (!code || code.clientId !== client.client_id || !this.hasGrant(code.userId, code))
            throw new InvalidGrantError("Invalid authorization code");
        return code;
    }

    private tokenCapacity(newFamily: boolean): void {
        if (
            this.access.size >= capacity ||
            this.refresh.size >= capacity ||
            (newFamily && this.families.size >= capacity)
        ) {
            throw new TemporarilyUnavailableError("Capacity reached");
        }
    }

    private issue(binding: Binding & { userId: string }, familyId: string, family: Family): OAuthTokens {
        const access = nonce();
        const refresh = nonce();
        const expiresAt = Math.min(this.now() + this.accessTtl, family.expiresAt);
        const common = {
            clientId: binding.clientId,
            userId: binding.userId,
            scopes: [...binding.scopes],
            resource: binding.resource,
            familyId,
        };
        this.access.set(hash(access), { ...common, scopes: [...common.scopes], expiresAt });
        this.refresh.set(hash(refresh), {
            ...common,
            scopes: [...common.scopes],
            expiresAt: family.expiresAt,
            used: false,
        });
        return {
            access_token: access,
            refresh_token: refresh,
            token_type: "Bearer",
            expires_in: expiresAt - this.now(),
            scope: binding.scopes.join(" "),
        };
    }

    private registeredClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
        const registered = this.clients.get(client.client_id);
        if (!registered || client.token_endpoint_auth_method !== "none") throw new InvalidClientError("Invalid client");
        return registered;
    }

    private requireResource(resource: URL | undefined): void {
        if (!resource || resource.href !== this.resource) throw new InvalidTargetError("Invalid resource");
    }

    private hasGrant(userId: string, binding: Binding): boolean {
        const grant = this.grants.get(JSON.stringify([userId, binding.clientId]));
        return !!grant && binding.scopes.every((scope) => grant.scopes.has(scope));
    }

    private consent(requestId: string, cookie: string): Pending {
        this.cleanup();
        const pending = this.pending.get(hash(requestId));
        if (!pending || !matches(cookie, pending.cookieHash)) throw new InvalidRequestError("Invalid consent request");
        return pending;
    }

    private consentRedirect(pending: Pending, name: "code" | "error", value: string): string {
        const url = new URL(pending.redirectUri);
        for (const field of ["code", "error", "state"]) url.searchParams.delete(field);
        url.searchParams.set(name, value);
        if (pending.state !== undefined) url.searchParams.set("state", pending.state);
        return url.href;
    }

    private cleanup(): void {
        const now = this.now();
        for (const [key, pending] of this.pending) if (pending.expiresAt <= now) this.pending.delete(key);
        for (const [key, code] of this.codes) if (code.expiresAt <= now) this.codes.delete(key);
        for (const [key, token] of this.access) if (token.expiresAt <= now) this.access.delete(key);
        for (const [key, token] of this.refresh) if (token.expiresAt <= now) this.refresh.delete(key);
        for (const [key, family] of this.families) if (family.expiresAt <= now) this.families.delete(key);
    }
}
