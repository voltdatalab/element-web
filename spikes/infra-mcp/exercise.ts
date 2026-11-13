/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LocalOAuthProvider } from "./LocalOAuthProvider.ts";
import { MatrixIdentityVerifier } from "./MatrixIdentityVerifier.ts";
import { createInfraMcpApp } from "./infraMcpApp.ts";

async function listen(server: Server): Promise<URL> {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}

async function stop(server: Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Exercise real local protocols against explicitly synthetic identities and status data. */
export async function exercise(): Promise<Record<string, unknown>> {
    const matrixProof = randomBytes(32).toString("base64url");
    const userId = "@operator:fixture.test";
    const matrix = createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        if (
            req.method !== "GET" ||
            req.url !== "/_matrix/client/v3/account/whoami" ||
            req.headers.authorization !== `Bearer ${matrixProof}`
        ) {
            res.writeHead(401).end(JSON.stringify({ errcode: "M_UNKNOWN_TOKEN" }));
            return;
        }
        res.end(JSON.stringify({ user_id: userId, is_guest: false }));
    });
    const http = createServer();
    let client: Client | undefined;
    try {
        const homeserver = await listen(matrix);
        const baseUrl = await listen(http);
        const resource = new URL("/mcp", baseUrl);
        const verifier = new MatrixIdentityVerifier({
            homeserver,
            allowedUsers: new Set([userId]),
            allowLoopbackHttp: true,
        });
        const clientId = "synthetic-sdk-client";
        const redirectUri = "http://127.0.0.1:34567/callback";
        const scope = "infra:read:demo-app:staging";
        const provider = new LocalOAuthProvider({
            resource,
            clients: [
                {
                    client_id: clientId,
                    client_name: "Synthetic SDK client",
                    redirect_uris: [redirectUri],
                    token_endpoint_auth_method: "none",
                    grant_types: ["authorization_code", "refresh_token"],
                    response_types: ["code"],
                },
            ],
        });
        provider.setGrant(userId, clientId, [scope]);
        let statusReads = 0;
        http.on(
            "request",
            createInfraMcpApp({
                baseUrl,
                provider,
                verifier,
                readStatus: async (application, environment) => {
                    statusReads++;
                    return { application, environment, healthy: true, version: "synthetic-v1" };
                },
            }),
        );
        const request = (path: string, init: RequestInit = {}) =>
            fetch(new URL(path, baseUrl), { ...init, signal: AbortSignal.timeout(5000) });
        const denied = await request("/mcp", { method: "POST" });
        assert.equal(denied.status, 401);
        assert.match(denied.headers.get("www-authenticate") ?? "", /resource_metadata=/);
        const metadata = await request("/.well-known/oauth-protected-resource/mcp");
        assert.equal((await metadata.json()).resource, resource.href);
        const codeVerifier = randomBytes(32).toString("base64url");
        const state = randomBytes(32).toString("base64url");
        const authorize = new URLSearchParams({
            client_id: clientId,
            response_type: "code",
            redirect_uri: redirectUri,
            resource: resource.href,
            scope,
            state,
            code_challenge_method: "S256",
            code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"),
        });
        const begun = await request(`/authorize?${authorize}`, { redirect: "manual" });
        assert.equal(begun.status, 302);
        const browserCookie = begun.headers.get("set-cookie")?.split(";")[0];
        assert.ok(browserCookie);
        const location = begun.headers.get("location");
        assert.ok(location);
        const consentUrl = new URL(location, baseUrl);
        assert.equal(consentUrl.origin, baseUrl.origin);
        const consentResponse = await request(consentUrl.pathname + consentUrl.search, {
            headers: { Cookie: browserCookie },
        });
        assert.equal(consentResponse.status, 200);
        const consent = await consentResponse.json();
        assert.deepEqual(consent.scopes, [scope]);
        const approved = await request("/consent", {
            method: "POST",
            redirect: "manual",
            headers: {
                Cookie: browserCookie,
                Origin: baseUrl.origin,
                Authorization: `Bearer ${matrixProof}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                request: consentUrl.searchParams.get("request"),
                csrf: consent.csrf,
                approve: true,
            }),
        });
        assert.equal(approved.status, 302);
        const callback = new URL(approved.headers.get("location")!);
        assert.equal(callback.origin + callback.pathname, redirectUri);
        assert.equal(callback.searchParams.get("state"), state);
        const code = callback.searchParams.get("code");
        assert.ok(code);
        const exchange = (params: Record<string, string>) =>
            request("/token", {
                method: "POST",
                body: new URLSearchParams({ client_id: clientId, resource: resource.href, ...params }),
            });
        const wrongProof = await exchange({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            code_verifier: "x".repeat(43),
        });
        assert.equal(wrongProof.status, 400);
        const issued = await exchange({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
        });
        assert.equal(issued.status, 200);
        const original = await issued.json();
        assert.notEqual(original.access_token, matrixProof);
        const refreshed = await exchange({ grant_type: "refresh_token", refresh_token: original.refresh_token });
        assert.equal(refreshed.status, 200);
        const tokens = await refreshed.json();
        assert.notEqual(tokens.refresh_token, original.refresh_token);
        client = new Client({ name: "infra-mcp-synthetic-demo", version: "0.1.0" });
        await client.connect(
            new StreamableHTTPClientTransport(resource, {
                requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
            }),
        );
        assert.deepEqual(
            (await client.listTools()).tools.map((tool) => tool.name),
            ["infra_status"],
        );
        const result = await client.callTool({
            name: "infra_status",
            arguments: { application: "demo-app", environment: "staging" },
        });
        assert.notEqual(result.isError, true);
        assert.match(JSON.stringify(result.content), /synthetic-v1/);
        const otherTarget = await client.callTool({
            name: "infra_status",
            arguments: { application: "other-app", environment: "staging" },
        });
        assert.equal(otherTarget.isError, true);
        assert.equal(statusReads, 1);
        const revoked = await request("/revoke", {
            method: "POST",
            body: new URLSearchParams({
                client_id: clientId,
                token: tokens.refresh_token,
                token_type_hint: "refresh_token",
            }),
        });
        assert.equal(revoked.status, 200);
        await assert.rejects(() => client!.listTools());
        assert.equal(await verifier.verify(matrixProof), userId);
        return {
            status: "PASS_LOCAL_SYNTHETIC_MCP",
            authenticatedToolCalls: statusReads,
            outOfScopeBlocked: true,
            revokedConnectionBlocked: true,
            pkceMismatchBlocked: true,
            matrixSessionStillValid: true,
            productionConnections: 0,
        };
    } finally {
        await client?.close().catch(() => undefined);
        await stop(http);
        await stop(matrix);
    }
}
