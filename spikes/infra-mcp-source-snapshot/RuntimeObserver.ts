/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { spawn, type ChildProcess } from "node:child_process";
import { chmod, link, lstat, mkdtemp, rmdir, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import nodePath from "node:path";
import { z } from "zod";

import { dockerRuntimeProbeSource } from "./DockerRuntimeProbe.ts";
import {
    infraAppRuntimeObservationSchema,
    infraRuntimeScope,
    type InfraRuntimeTarget,
    type InfraAppRuntimeObservation,
} from "./infraRuntimeTypes.ts";

/** Trusted private-process configuration, never exposed as MCP tool arguments. */
export interface RuntimeObserverConfig {
    target: InfraRuntimeTarget;
    serviceName: string;
    sshHost: string;
    sshUser: string;
    identityFile: string;
    knownHostsFile: string;
    socketPath: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
}

/** Trusted process seam for local pipe/lifecycle fixtures; RPC cannot choose the executable or arguments. */
export interface RuntimeObserverDependencies {
    spawn?: (command: string, args: readonly string[]) => ChildProcess;
}

const { dirname, isAbsolute, join } = nodePath;
const quote = (value: string): string => "'" + value.replace(/'/g, "'\"'\"'") + "'";
const absolutePath = z
    .string()
    .max(4096)
    .refine(
        (path) =>
            isAbsolute(path) &&
            /^\/[A-Za-z0-9_./-]+$/.test(path) &&
            path
                .slice(1)
                .split("/")
                .every((part) => part !== "" && part !== "." && part !== ".."),
    );
const slug = z
    .string()
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
const configSchema = z.strictObject({
    target: z.strictObject({ host: slug, application: slug, environment: z.enum(["staging", "production"]) }),
    serviceName: z.string(),
    sshHost: z
        .string()
        .max(253)
        .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
    sshUser: z
        .string()
        .max(63)
        .regex(/^[a-z_][a-z0-9_-]*$/),
    identityFile: absolutePath,
    knownHostsFile: absolutePath,
    socketPath: absolutePath.refine((path) => Buffer.byteLength(path) <= 103),
    timeoutMs: z.number().int().min(10).max(30000).optional(),
    maxOutputBytes: z.number().int().min(1024).max(131072).optional(),
});

function validateConfig(config: RuntimeObserverConfig): RuntimeObserverConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success || parsed.data.serviceName !== `srv-captain--${parsed.data.target.application}`) {
        throw new Error("Invalid runtime observer configuration");
    }
    infraRuntimeScope(parsed.data.target);
    return parsed.data;
}

/** Builds a single fixed diagnostic command, with code and target encoded as separate shell arguments. */
export function runtimeObserverSshArguments(config: RuntimeObserverConfig): string[] {
    config = validateConfig(config);
    const data = JSON.stringify({ ...config.target, serviceName: config.serviceName });
    // A saved Docker context must not redirect this host-bound observation to another machine.
    const remote = [
        "set -eu",
        `[ "$(hostname)" = ${quote(config.target.host)} ] || exit 41`,
        "containers=$(docker --host unix:///var/run/docker.sock ps " +
            "--filter 'label=com.docker.swarm.service.name=captain-captain' " +
            "--filter 'status=running' --format '{{.ID}}')",
        "case \"$containers\" in ''|*[!0-9a-f]*) exit 42;; esac",
        '[ "${#containers}" -ge 12 ] && [ "${#containers}" -le 64 ] || exit 42',
        `exec docker --host unix:///var/run/docker.sock exec "$containers" node -e ${quote(dockerRuntimeProbeSource)} ${quote(data)}`,
    ].join("; ");
    return [
        "-F",
        "/dev/null",
        "-T",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${config.knownHostsFile}`,
        "-o",
        "IdentityAgent=none",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "UpdateHostKeys=no",
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        "-o",
        "PasswordAuthentication=no",
        "-o",
        "KbdInteractiveAuthentication=no",
        "-o",
        "ProxyCommand=none",
        "-o",
        "ProxyJump=none",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "ConnectionAttempts=1",
        "-o",
        "ConnectTimeout=5",
        "-i",
        config.identityFile,
        "-l",
        config.sshUser,
        "--",
        config.sshHost,
        remote,
    ];
}

/** Rejects symlinks in every existing path component, without canonicalizing the configured literal. */
export async function assertRuntimePath(path: string): Promise<void> {
    if (!absolutePath.safeParse(path).success) throw new Error("Runtime observer unavailable");
    let current = "";
    for (const part of path.slice(1).split("/")) {
        current += "/" + part;
        if ((await lstat(current)).isSymbolicLink()) throw new Error("Runtime observer unavailable");
    }
}

/** Checks metadata only: the observer never loads identity-file contents. */
export async function assertPrivateRuntimeFile(path: string): Promise<void> {
    await assertRuntimePath(path);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o177) !== 0) {
        throw new Error("Runtime observer unavailable");
    }
}

/** One application, one private Unix endpoint, one owned SSH child at a time. */
export class RuntimeObserver {
    private readonly config: RuntimeObserverConfig;
    private readonly launch: (command: string, args: readonly string[]) => ChildProcess;
    private server: Server | undefined;
    private started = false;
    private busy = false;
    private child: ChildProcess | undefined;
    private pending: Promise<InfraAppRuntimeObservation> | undefined;
    private listeningDirectory: string | undefined;
    private publishedIdentity: { dev: number; ino: number } | undefined;
    private closing: Promise<void> | undefined;
    private stopping = false;
    private startup: Promise<void> | undefined;

    public constructor(config: RuntimeObserverConfig, dependencies: RuntimeObserverDependencies = {}) {
        this.config = validateConfig(config);
        this.launch =
            dependencies.spawn ??
            ((command, args) =>
                spawn(command, args, {
                    shell: false,
                    stdio: ["ignore", "pipe", "ignore"],
                }));
    }

    /** Binds once; refuses existing paths and publishes only an owner-only Unix socket. */
    public async start(): Promise<void> {
        if (this.started || this.stopping) throw new Error("Runtime observer unavailable");
        this.started = true;
        this.startup = this.bind();
        await this.startup;
    }

    private async bind(): Promise<void> {
        try {
            await assertRuntimePath(dirname(this.config.socketPath));
            const directory = await lstat(dirname(this.config.socketPath));
            if (!directory.isDirectory() || directory.uid !== process.getuid!() || (directory.mode & 0o777) !== 0o700) {
                throw new Error("Unavailable");
            }
            await assertPrivateRuntimeFile(this.config.identityFile);
            await assertPrivateRuntimeFile(this.config.knownHostsFile);
            try {
                await lstat(this.config.socketPath);
                throw new Error("Unavailable");
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
        } catch {
            throw new Error("Runtime observer unavailable");
        }
        const server = createServer(async (request, response) => {
            const deadline = performance.now() + (this.config.timeoutMs ?? 8000);
            response.setHeader("connection", "close");
            response.setHeader("cache-control", "no-store");
            if (
                request.method !== "GET" ||
                request.url !== "/runtime" ||
                request.headers["transfer-encoding"] !== undefined ||
                (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0") ||
                request.headers.authorization !== undefined ||
                request.headers.cookie !== undefined
            ) {
                response.writeHead(400).end();
                return;
            }
            if (this.busy || this.stopping) {
                response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify(this.unavailable()));
                return;
            }
            this.busy = true;
            this.pending = this.observe(deadline);
            const observation = await this.pending;
            this.pending = undefined;
            this.busy = false;
            const body = JSON.stringify(observation);
            response.setHeader("content-type", "application/json");
            // Only prepared bytes may cross the last synchronous deadline check.
            if (performance.now() >= deadline) {
                response.end(JSON.stringify(this.unavailable()));
                return;
            }
            response.end(body);
        });
        server.maxConnections = 16;
        server.maxRequestsPerSocket = 1;
        server.headersTimeout = 5000;
        server.requestTimeout = 5000;
        server.setTimeout(35000, (socket) => socket.destroy());
        try {
            this.listeningDirectory = await mkdtemp(join(dirname(this.config.socketPath), ".o-"));
            const listeningPath = join(this.listeningDirectory, "s");
            if (Buffer.byteLength(listeningPath) > 103) throw new Error("Unavailable");
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(listeningPath, () => {
                    server.removeListener("error", reject);
                    resolve();
                });
            });
            this.server = server;
            await chmod(listeningPath, 0o600);
            const identity = await lstat(listeningPath);
            // Node unlinks its listening pathname blindly on close. Publish a separate exclusive hard link so
            // closing Node's own hidden socket cannot unlink a replacement at the configured public pathname.
            await link(listeningPath, this.config.socketPath);
            this.publishedIdentity = { dev: identity.dev, ino: identity.ino };
        } catch {
            await this.closeOwned();
            throw new Error("Runtime observer unavailable");
        }
    }

    /** Reaps the owned child and listener, preserving any replacement entry at the configured pathname. */
    public async close(): Promise<void> {
        this.stopping = true;
        this.closing ??= (async () => {
            try {
                await this.startup;
            } catch {
                /* Failed binding already cleans its own entries. */
            }
            await this.closeOwned();
        })();
        await this.closing;
    }

    private async closeOwned(): Promise<void> {
        const server = this.server;
        this.server = undefined;
        const published = this.publishedIdentity;
        this.publishedIdentity = undefined;
        const directory = this.listeningDirectory;
        this.listeningDirectory = undefined;
        this.child?.kill("SIGKILL");
        await this.pending;
        if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        if (published) {
            try {
                const stat = await lstat(this.config.socketPath);
                if (stat.isSocket() && stat.dev === published.dev && stat.ino === published.ino) {
                    await unlink(this.config.socketPath);
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Runtime observer unavailable");
            }
        }
        if (directory) await rmdir(directory);
    }

    private async observe(deadline: number): Promise<InfraAppRuntimeObservation> {
        if (this.stopping || performance.now() >= deadline) return this.unavailable();
        try {
            await assertPrivateRuntimeFile(this.config.identityFile);
            if (this.stopping || performance.now() >= deadline) return this.unavailable();
            await assertPrivateRuntimeFile(this.config.knownHostsFile);
        } catch {
            return this.unavailable();
        }
        if (this.stopping || performance.now() >= deadline) return this.unavailable();
        const observation = await new Promise<InfraAppRuntimeObservation>((resolve) => {
            let child: ChildProcess;
            try {
                const args = runtimeObserverSshArguments(this.config);
                if (this.stopping || performance.now() >= deadline) {
                    resolve(this.unavailable());
                    return;
                }
                child = this.launch("/usr/bin/ssh", args);
            } catch {
                resolve(this.unavailable());
                return;
            }
            this.child = child;
            const chunks: Buffer[] = [];
            let bytes = 0;
            let failed = false;
            const abort = (): void => {
                failed = true;
                chunks.length = 0;
                child.stdout?.destroy();
                child.stderr?.destroy();
                child.kill("SIGKILL");
            };
            const timer = setTimeout(abort, Math.max(1, deadline - performance.now()));
            if (!child.stdout) abort();
            child.stdout?.on("data", (chunk: Buffer) => {
                bytes += chunk.length;
                if (performance.now() >= deadline || bytes > (this.config.maxOutputBytes ?? 65536)) abort();
                else if (!failed) chunks.push(chunk);
            });
            child.stdout?.on("error", abort);
            child.on("error", () => {
                failed = true;
            });
            child.on("close", (code) => {
                clearTimeout(timer);
                this.child = undefined;
                try {
                    if (failed || code !== 0 || performance.now() >= deadline) throw new Error("Unavailable");
                    const observation = infraAppRuntimeObservationSchema.parse(
                        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))),
                    );
                    if (
                        observation.host !== this.config.target.host ||
                        observation.application !== this.config.target.application ||
                        observation.environment !== this.config.target.environment ||
                        performance.now() >= deadline
                    )
                        throw new Error("Unavailable");
                    resolve(observation);
                } catch {
                    resolve(this.unavailable());
                }
            });
        });
        return performance.now() < deadline ? observation : this.unavailable();
    }

    private unavailable(): InfraAppRuntimeObservation {
        return {
            ...this.config.target,
            observedAt: new Date().toISOString(),
            result: "unavailable",
            runtime: null,
            healthHttp: "not_checked",
            applicationVersion: null,
        };
    }
}
