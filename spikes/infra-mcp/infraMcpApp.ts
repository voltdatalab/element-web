/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import express, { type Express, type ErrorRequestHandler } from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { ConsentProvider } from "./ConsentProvider.ts";

/** Fixed dependencies for an ephemeral, loopback-only MCP experiment. */
export interface InfraMcpOptions {
    baseUrl: URL;
    provider: ConsentProvider;
    verifier: { verify(token: string): Promise<string> };
    readStatus(application: string, environment: string): Promise<unknown>;
}

/** Build the HTTP experiment without binding a port or touching live infrastructure. */
export function createInfraMcpApp(options: InfraMcpOptions): Express {
    const baseUrl = new URL(options.baseUrl.href);
    if (
        baseUrl.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname) ||
        baseUrl.username ||
        baseUrl.password ||
        baseUrl.pathname !== "/" ||
        baseUrl.search ||
        baseUrl.hash
    )
        throw new Error("loopback_url_required");
    const resource = new URL("/mcp", baseUrl);
    const app = express();
    app.disable("x-powered-by");
    app.use((req, res, next) => {
        if (req.headers.host !== baseUrl.host || (req.headers.origin && req.headers.origin !== baseUrl.origin)) {
            res.status(403).json({ error: "forbidden" });
            return;
        }
        next();
    });
    app.use(express.json({ limit: "4kb" }));
    app.get("/consent", (req, res) => {
        res.set({
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        });
        try {
            const request = req.query.request;
            if (typeof request !== "string") throw new Error("invalid_request");
            const cookie = /(?:^|;\s*)infra_consent=([^;]*)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
            res.json(options.provider.describeConsent(request, cookie));
        } catch {
            res.status(403).json({ error: "consent_denied" });
        }
    });
    app.post("/consent", async (req, res) => {
        try {
            const { request, csrf, approve } = req.body;
            if (
                req.headers.origin !== baseUrl.origin ||
                typeof request !== "string" ||
                typeof csrf !== "string" ||
                typeof approve !== "boolean"
            )
                throw new Error("invalid_request");
            const cookie = /(?:^|;\s*)infra_consent=([^;]*)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
            options.provider.assertConsent(request, cookie, csrf);
            if (!approve) {
                res.redirect(options.provider.denyConsent(request, cookie, csrf));
                return;
            }
            const proof = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? "")?.[1];
            if (!proof) throw new Error("unauthorized");
            const userId = await options.verifier.verify(proof);
            res.redirect(options.provider.completeConsent(request, cookie, csrf, userId));
        } catch {
            res.status(403).json({ error: "consent_denied" });
        }
    });
    // The pilot uses exact static callbacks; the SDK otherwise accepts any loopback port and redirects errors there.
    app.use("/authorize", express.urlencoded({ extended: false, limit: "4kb" }), async (req, res, next) => {
        if (req.method !== "GET" && req.method !== "POST") {
            next();
            return;
        }
        res.setHeader("Cache-Control", "no-store");
        const params: Record<string, unknown> | undefined = req.method === "POST" ? req.body : req.query;
        const clientId = params?.client_id;
        const redirectUri = params?.redirect_uri;
        if (typeof clientId !== "string" || typeof redirectUri !== "string") {
            res.status(400).json({ error: "invalid_request" });
            return;
        }
        const client = await options.provider.clientsStore.getClient(clientId);
        if (!client) {
            res.status(400).json({ error: "invalid_client" });
            return;
        }
        if (!client.redirect_uris.includes(redirectUri)) {
            res.status(400).json({ error: "invalid_request" });
            return;
        }
        next();
    });
    app.use(mcpAuthRouter({ provider: options.provider, issuerUrl: baseUrl, resourceServerUrl: resource }));
    app.use(
        "/mcp",
        requireBearerAuth({
            verifier: options.provider,
            expectedResource: resource,
            resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
        }),
    );
    app.post("/mcp", async (req, res) => {
        const server = new McpServer({ name: "infra-mcp-lab", version: "0.1.0" });
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });
        server.registerTool(
            "infra_status",
            {
                description:
                    "Read a synthetic application's status within the current authorization. No deployment or shell access.",
                inputSchema: {
                    application: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
                    environment: z.enum(["staging", "production"]),
                },
                annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
            },
            async ({ application, environment }, extra) => {
                try {
                    const scope = `infra:read:${application}:${environment}`;
                    const token = extra.authInfo?.token ?? "";
                    const info = options.provider.assertCurrentAccess(token, scope);
                    if (info.resource?.href !== resource.href || !info.scopes.includes(scope))
                        throw new Error("forbidden");
                    const status = z
                        .object({
                            application: z.literal(application),
                            environment: z.literal(environment),
                            healthy: z.boolean(),
                            version: z.string().min(1).max(80),
                        })
                        .strict()
                        .parse(await options.readStatus(application, environment));
                    options.provider.assertCurrentAccess(token, scope);
                    return { content: [{ type: "text", text: JSON.stringify(status) }] };
                } catch {
                    return { isError: true, content: [{ type: "text", text: "operation_denied" }] };
                }
            },
        );
        res.on("close", () => {
            void transport.close();
            void server.close();
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch {
            if (!res.headersSent) res.status(500).json({ error: "operation_failed" });
        }
    });
    app.all("/mcp", (_req, res) => {
        res.status(405).json({ error: "method_not_allowed" });
    });
    const failure: ErrorRequestHandler = (_error, _req, res, _next) => {
        if (!res.headersSent) res.status(400).json({ error: "invalid_request" });
    };
    app.use(failure);
    return app;
}
