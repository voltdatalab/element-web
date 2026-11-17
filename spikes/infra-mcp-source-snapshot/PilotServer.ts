/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { createServer, type Server } from "node:http";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Express } from "express";

import { closeInfraMcpApp, createInfraMcpApp } from "./infraMcpApp.ts";
import { PrivateUnixHttpServer } from "./PrivateUnixHttpServer.ts";
import { SqliteOAuthStateStore } from "./SqliteOAuthStateStore.ts";
import { MatrixIdentityVerifier } from "./MatrixIdentityVerifier.ts";
import { UnixRuntimeReader } from "./UnixRuntimeReader.ts";
import { createPilotPolicy } from "./pilot-policy.ts";
import { parsePilotConfiguration, type PilotConfiguration } from "./pilotConfiguration.ts";
import { ensurePrivatePilotDirectory } from "./pilot-private-path.ts";
import type { PilotControlAction } from "./pilot-control-types.ts";

/** Single-use persistent pilot. Construction and module import do not open storage or listen. */
export class PilotServer {
    private readonly config: PilotConfiguration;
    private readonly matrixVerifier: MatrixIdentityVerifier;
    private store?: SqliteOAuthStateStore;
    private server?: Server;
    private app?: Express;
    private operator?: PrivateUnixHttpServer;
    private startup?: Promise<void>;
    private closing?: Promise<void>;
    private stopping = false;

    public constructor(
        configuration: PilotConfiguration,
        dependencies: { matrixVerifier?: MatrixIdentityVerifier } = {},
    ) {
        this.config = parsePilotConfiguration(configuration);
        this.matrixVerifier =
            dependencies.matrixVerifier ??
            new MatrixIdentityVerifier({
                homeserver: new URL(this.config.matrixHomeserverUrl),
                allowedUsers: new Set([this.config.actorMxid]),
            });
    }

    /** Open dedicated SQLite state and bind only the explicitly configured internal HTTP address. */
    public async start(): Promise<void> {
        if (this.startup || this.stopping) throw new Error("Pilot unavailable");
        this.startup = this.bind();
        await this.startup;
    }

    private async bind(): Promise<void> {
        try {
            const config = this.config;
            ensurePrivatePilotDirectory(config.stateDirectory);
            const entries = readdirSync(config.stateDirectory);
            if (
                entries.length &&
                (entries.length !== 2 || !entries.includes("oauth") || !entries.includes("policy.json"))
            )
                throw new Error("Pilot unavailable");
            this.store = new SqliteOAuthStateStore({ directory: join(config.stateDirectory, "oauth") });
            const baseUrl = new URL(config.publicBaseUrl);
            const { provider, control } = createPilotPolicy(config, this.store);
            this.operator = new PrivateUnixHttpServer(config.operatorSocketPath, (req, res) => {
                res.setHeader("connection", "close");
                res.setHeader("cache-control", "no-store");
                res.setHeader("content-type", "application/json");
                const action = req.url?.slice(1);
                if (
                    this.stopping ||
                    req.method !== "POST" ||
                    !["status", "revoke", "restore"].includes(action ?? "") ||
                    req.headers["transfer-encoding"] !== undefined ||
                    (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0") ||
                    req.headers.authorization !== undefined ||
                    req.headers.cookie !== undefined ||
                    req.headers.origin !== undefined
                ) {
                    res.writeHead(400).end(JSON.stringify({ error: "invalid_request" }));
                    return;
                }
                try {
                    res.end(JSON.stringify(control(action as PilotControlAction)));
                } catch {
                    res.writeHead(503).end(JSON.stringify({ error: "operator_unavailable" }));
                }
            });
            await this.operator.start();
            this.app = createInfraMcpApp({
                baseUrl,
                provider,
                verifier: this.matrixVerifier,
                runtimeReader: new UnixRuntimeReader({ socketPath: config.observerSocketPath, target: config.target }),
                transportMode: config.transportMode,
                elementConsentScreen: true,
            });
            this.server = createServer(this.app);
            if (this.stopping) throw new Error("Pilot unavailable");
            const server = this.server;
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(config.listenPort, config.listenHost, () => {
                    server.removeListener("error", reject);
                    resolve();
                });
            });
        } catch {
            await this.closeOwned();
            throw new Error("Pilot unavailable");
        }
    }

    /** Close only owned listeners and storage, releasing SQLite's exclusive writer lock. */
    public async close(): Promise<void> {
        this.stopping = true;
        this.closing ??= (async () => {
            try {
                await this.startup;
            } catch {
                /* Failed startup cleans its resources. */
            }
            await this.closeOwned();
        })();
        await this.closing;
    }

    private async closeOwned(): Promise<void> {
        const app = this.app;
        this.app = undefined;
        const draining = app ? closeInfraMcpApp(app) : Promise.resolve();
        const server = this.server;
        this.server = undefined;
        if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        try {
            await draining;
            await this.operator?.close();
        } finally {
            this.operator = undefined;
            this.store?.close();
            this.store = undefined;
        }
    }
}
