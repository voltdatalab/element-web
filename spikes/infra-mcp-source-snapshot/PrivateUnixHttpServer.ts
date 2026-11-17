/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { chmod, link, lstat, mkdtemp, rmdir, unlink } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { dirname, join } from "node:path";

import { assertPilotPath, assertPrivatePilotDirectory } from "./pilot-private-path.ts";

/** Owner-only Unix listener with exclusive publication; never binds TCP or adopts an existing entry. */
export class PrivateUnixHttpServer {
    private readonly socketPath: string;
    private readonly handler: RequestListener;
    private server?: Server;
    private directory?: string;
    private published?: { dev: number; ino: number };
    private startup?: Promise<void>;
    private closing?: Promise<void>;
    private stopping = false;

    public constructor(socketPath: string, handler: RequestListener) {
        this.socketPath = socketPath;
        this.handler = handler;
    }

    /** Publish a 0600 hard link in the existing 0700 directory only after the hidden listener is ready. */
    public async start(): Promise<void> {
        if (this.startup || this.stopping) throw new Error("Private operator unavailable");
        this.startup = this.bind();
        await this.startup;
    }

    private async bind(): Promise<void> {
        try {
            assertPilotPath(this.socketPath);
            assertPrivatePilotDirectory(dirname(this.socketPath));
            if (Buffer.byteLength(this.socketPath) > 103 || lstatSync(this.socketPath, { throwIfNoEntry: false }))
                throw new Error();
            this.directory = await mkdtemp(join(dirname(this.socketPath), ".p-"));
            await chmod(this.directory, 0o700);
            const hiddenPath = join(this.directory, "s");
            if (Buffer.byteLength(hiddenPath) > 103 || this.stopping) throw new Error();
            const server = createServer(this.handler);
            this.server = server;
            server.maxConnections = 8;
            server.maxRequestsPerSocket = 1;
            server.headersTimeout = 5000;
            server.requestTimeout = 5000;
            server.setTimeout(5000, (socket) => socket.destroy());
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(hiddenPath, () => {
                    server.removeListener("error", reject);
                    resolve();
                });
            });
            await chmod(hiddenPath, 0o600);
            const identity = await lstat(hiddenPath);
            if (this.stopping) throw new Error();
            // Node blindly unlinks its listening pathname on close. Keep that hidden; the public hard link
            // is exclusive and is removed only if it still points to this instance's socket.
            await link(hiddenPath, this.socketPath);
            this.published = { dev: identity.dev, ino: identity.ino };
        } catch {
            await this.closeOwned();
            throw new Error("Private operator unavailable");
        }
    }

    /** Stop only this instance; retain replacement public files, sockets and unrelated directory entries. */
    public async close(): Promise<void> {
        this.stopping = true;
        this.closing ??= (async () => {
            try {
                await this.startup;
            } catch {
                /* Failed startup already cleaned its owned resources. */
            }
            await this.closeOwned();
        })();
        await this.closing;
    }

    private async closeOwned(): Promise<void> {
        const server = this.server;
        this.server = undefined;
        if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        const identity = this.published;
        this.published = undefined;
        if (identity) {
            try {
                const stat = await lstat(this.socketPath);
                if (stat.isSocket() && stat.ino === identity.ino && stat.dev === identity.dev)
                    await unlink(this.socketPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Private operator unavailable");
            }
        }
        const directory = this.directory;
        this.directory = undefined;
        if (directory) await rmdir(directory);
    }
}
