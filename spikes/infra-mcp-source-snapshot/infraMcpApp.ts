/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import express, { type Express, type ErrorRequestHandler } from "express";
import {
    createOAuthMetadata,
    mcpAuthRouter,
    getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { ConsentProvider } from "./ConsentProvider.ts";
import {
    infraAppRuntimeObservationSchema,
    infraRuntimeScope,
    type InfraAppRuntimeReader,
} from "./infraRuntimeTypes.ts";

const nativeRequestId = /^[A-Za-z0-9_-]{43}$/;
const shutdowns = new WeakMap<Express, () => Promise<void>>();

/** Stop admission, close owned SDK transports and drain admitted reads before their authority store closes. */
export async function closeInfraMcpApp(app: Express): Promise<void> {
    await shutdowns.get(app)?.();
}

function consentCookie(header: string | undefined): string {
    const entries = (header ?? "")
        .split(";")
        .map((part) => part.trimStart())
        .filter((part) => part.startsWith("infra_consent="));
    // Ambiguous cookies must not silently choose one browser binding over another.
    if (entries.length !== 1) throw new Error("invalid_cookie");
    const value = entries[0].slice("infra_consent=".length);
    if (!value || value.length > 256) throw new Error("invalid_cookie");
    return value;
}

/** Fixed dependencies; runtime mode never registers or falls back to the synthetic tool. */
export interface InfraMcpOptions {
    baseUrl: URL;
    provider: ConsentProvider;
    verifier: { verify(token: string): Promise<string> };
    readStatus?: (application: string, environment: string) => Promise<unknown>;
    runtimeReader?: InfraAppRuntimeReader;
    transportMode?: "loopback" | "https-proxy";
    elementConsentScreen?: boolean;
}

/** Build the HTTP experiment without binding a port or touching live infrastructure. */
export function createInfraMcpApp(options: InfraMcpOptions): Express {
    if ((options.runtimeReader !== undefined) === (options.readStatus !== undefined))
        throw new Error("backend_mode_required");
    const baseUrl = new URL(options.baseUrl.href);
    const reader = options.runtimeReader;
    const target = reader && Object.freeze({ ...reader.target });
    const runtimeScope = target && infraRuntimeScope(target);
    if (runtimeScope && runtimeScope.length > 128) throw new Error("invalid_runtime_scope");
    const scopesSupported = runtimeScope ? [runtimeScope] : undefined;
    const elementConsentScreen = options.elementConsentScreen === true;
    const transportMode = options.transportMode ?? "loopback";
    const protocolAllowed =
        transportMode === "https-proxy"
            ? baseUrl.protocol === "https:"
            : transportMode === "loopback" &&
              baseUrl.protocol === "http:" &&
              ["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname);
    if (
        !protocolAllowed ||
        baseUrl.username ||
        baseUrl.password ||
        baseUrl.pathname !== "/" ||
        baseUrl.search ||
        baseUrl.hash ||
        /[?#]/.test(baseUrl.href)
    )
        throw new Error("loopback_url_required");
    const resource = new URL("/mcp", baseUrl);
    if (
        options.provider.authorizationResponseIssuer !== undefined &&
        options.provider.authorizationResponseIssuer !== baseUrl.href
    )
        throw new Error("issuer_mismatch");
    const app = express();
    let stopping = false;
    let closing: Promise<void> | undefined;
    const readers = new Set<Promise<unknown>>();
    const cleanups = new Set<() => Promise<void>>();
    const readOwned = async <T>(operation: () => Promise<T>): Promise<T> => {
        const pending = operation();
        readers.add(pending);
        try {
            return await pending;
        } finally {
            readers.delete(pending);
        }
    };
    shutdowns.set(app, () => {
        stopping = true;
        closing ??= (async () => {
            await Promise.allSettled([...cleanups].map((cleanup) => cleanup()));
            await Promise.allSettled([...readers]);
        })();
        return closing;
    });
    app.disable("x-powered-by");
    app.use("/consent", (_req, res, next) => {
        res.set({
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        });
        next();
    });
    app.use((req, res, next) => {
        const headerNames = req.rawHeaders.filter((_value, index) => index % 2 === 0).map((name) => name.toLowerCase());
        if (
            headerNames.filter((name) => name === "host").length !== 1 ||
            headerNames.filter((name) => name === "origin").length > 1 ||
            req.headers.host !== baseUrl.host ||
            (req.headers.origin !== undefined && req.headers.origin !== baseUrl.origin)
        ) {
            res.status(403).json({ error: "forbidden" });
            return;
        }
        next();
    });
    app.use(express.json({ limit: "4kb" }));
    app.use((_req, res, next) => {
        if (stopping) {
            res.status(503).json({ error: "service_unavailable" });
            return;
        }
        next();
    });
    app.get("/consent", (req, res) => {
        try {
            const request = req.query.request;
            if (typeof request !== "string") throw new Error("invalid_request");
            if (elementConsentScreen && req.accepts(["json", "html"]) === "html") {
                if (!nativeRequestId.test(request)) throw new Error("invalid_request");
                res.redirect(`/#/mcp/consent/${request}`);
                return;
            }
            const cookie = consentCookie(req.headers.cookie);
            res.json(options.provider.describeConsent(request, cookie));
        } catch {
            res.status(403).json({ error: "consent_denied" });
        }
    });
    app.get("/consent/details", (req, res) => {
        try {
            const request = req.query.request;
            if (
                typeof request !== "string" ||
                !nativeRequestId.test(request) ||
                !options.provider.describeConsentDetails
            )
                throw new Error("invalid_request");
            const cookie = consentCookie(req.headers.cookie);
            res.json(options.provider.describeConsentDetails(request, cookie));
        } catch {
            res.status(403).json({ error: "consent_denied" });
        }
    });
    app.post("/consent", async (req, res) => {
        try {
            if (req.headers.origin !== baseUrl.origin) throw new Error("invalid_request");
            const { request, csrf, approve } = z
                .object({
                    request: z.string().min(1).max(256),
                    csrf: z.string().min(1).max(256),
                    approve: z.boolean(),
                })
                .strict()
                .parse(req.body);
            const cookie = consentCookie(req.headers.cookie);
            options.provider.assertConsent(request, cookie, csrf);
            let redirectTo: string;
            if (!approve) {
                redirectTo = options.provider.denyConsent(request, cookie, csrf);
            } else {
                const proof = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? "")?.[1];
                if (!proof) throw new Error("unauthorized");
                const userId = await readOwned(() => options.verifier.verify(proof));
                if (stopping) throw new Error("consent_denied");
                redirectTo = options.provider.completeConsent(request, cookie, csrf, userId);
            }
            res.clearCookie("infra_consent", {
                httpOnly: true,
                sameSite: "strict",
                path: "/consent",
                secure: baseUrl.protocol === "https:",
            });
            res.json({ redirectTo });
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
    // Preregistered public clients need accurate metadata; issuer support is opt-in on the provider.
    app.get("/.well-known/oauth-authorization-server", (_req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.json({
            ...createOAuthMetadata({ provider: options.provider, issuerUrl: baseUrl, scopesSupported }),
            token_endpoint_auth_methods_supported: ["none"],
            revocation_endpoint_auth_methods_supported: ["none"],
            ...(options.provider.authorizationResponseIssuer
                ? { authorization_response_iss_parameter_supported: true }
                : {}),
        });
    });
    app.use((_req, res, next) => {
        // SDK token/revocation/metadata handlers install wildcard CORS internally, without a configuration seam.
        // Constrain that header to the installation origin; the earlier literal Origin gate still runs first.
        const setHeader = res.setHeader.bind(res);
        res.setHeader = (name, value) =>
            setHeader(name, name.toLowerCase() === "access-control-allow-origin" ? baseUrl.origin : value);
        next();
    });
    app.use(
        mcpAuthRouter({ provider: options.provider, issuerUrl: baseUrl, resourceServerUrl: resource, scopesSupported }),
    );
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
        let cleaned: Promise<void> | undefined;
        const cleanup = (): Promise<void> => {
            cleaned ??= (async () => {
                // SDK JSON-response close clears its resolver without ending the Node response.
                if (stopping && !res.writableEnded) res.destroy();
                await Promise.allSettled([transport.close(), server.close()]);
                cleanups.delete(cleanup);
            })();
            return cleaned;
        };
        cleanups.add(cleanup);
        res.once("close", () => {
            void cleanup();
        });
        if (reader && target && runtimeScope) {
            server.registerTool(
                "infra_app_runtime",
                {
                    description:
                        "Read the configured application's runtime evidence. HTTP health and application version are not checked.",
                    inputSchema: z.strictObject({
                        host: z.literal(target.host),
                        application: z.literal(target.application),
                        environment: z.literal(target.environment),
                    }),
                    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
                },
                async (_arguments, extra) => {
                    const token = extra.authInfo?.token ?? "";
                    const authorize = (): void => {
                        if (stopping || extra.signal.aborted) throw new Error("operation_denied");
                        const info = options.provider.assertCurrentAccess(token, runtimeScope);
                        if (info.resource?.href !== resource.href || !info.scopes.includes(runtimeScope))
                            throw new Error("forbidden");
                    };
                    try {
                        authorize();
                        const outcome = await readOwned(() => reader.read(authorize)).then(
                            (value) => ({ ok: true as const, value }),
                            () => ({ ok: false as const }),
                        );
                        // Revalidate both outcomes outside backend failure handling; never authorize an unavailable fallback.
                        authorize();
                        if (!outcome.ok) throw new Error("operation_denied");
                        const observation = infraAppRuntimeObservationSchema.parse(outcome.value);
                        if (
                            observation.host !== target.host ||
                            observation.application !== target.application ||
                            observation.environment !== target.environment
                        )
                            throw new Error("target_mismatch");
                        authorize();
                        const text = JSON.stringify(observation);
                        authorize();
                        return { content: [{ type: "text", text }] };
                    } catch {
                        return { isError: true, content: [{ type: "text", text: "operation_denied" }] };
                    }
                },
            );
        } else
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
                            .parse(await readOwned(() => options.readStatus!(application, environment)));
                        options.provider.assertCurrentAccess(token, scope);
                        return { content: [{ type: "text", text: JSON.stringify(status) }] };
                    } catch {
                        return { isError: true, content: [{ type: "text", text: "operation_denied" }] };
                    }
                },
            );
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
