/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { lstat } from "node:fs/promises";
import type { Stats } from "node:fs";
import nodePath from "node:path";
import { z } from "zod";

import {
    infraAppRuntimeObservationSchema,
    infraRuntimeScope,
    snapshotInfraRuntimeTarget,
    type InfraRuntimeTarget,
    type InfraAppRuntimeReader,
    type InfraAppRuntimeObservation,
} from "./infraRuntimeTypes.ts";

/** MCP-side configuration contains a socket path and logical target, never SSH keys or upstream tokens. */
export interface UnixRuntimeReaderOptions {
    socketPath: string;
    target: InfraRuntimeTarget;
    timeoutMs?: number;
    maxOutputBytes?: number;
}

const { dirname, isAbsolute } = nodePath;
const optionsSchema = z.strictObject({
    socketPath: z
        .string()
        .max(103)
        .refine(
            (path) =>
                isAbsolute(path) &&
                Buffer.byteLength(path) <= 103 &&
                !path.includes("\0") &&
                path
                    .slice(1)
                    .split("/")
                    .every((part) => part !== "" && part !== "." && part !== ".."),
        ),
    target: z.custom<InfraRuntimeTarget>(),
    timeoutMs: z.number().int().min(10).max(30000).optional(),
    maxOutputBytes: z.number().int().min(1024).max(131072).optional(),
});

/** Reads one executor-owned target over a private Unix socket; no network listener is created. */
export class UnixRuntimeReader implements InfraAppRuntimeReader {
    public readonly target: Readonly<InfraRuntimeTarget>;
    private readonly socketPath: string;
    private readonly timeoutMs: number;
    private readonly maxOutputBytes: number;

    public constructor(options: UnixRuntimeReaderOptions) {
        const parsed = optionsSchema.safeParse(options);
        if (!parsed.success) throw new Error("Invalid Unix runtime reader configuration");
        this.target = snapshotInfraRuntimeTarget(parsed.data.target);
        infraRuntimeScope(this.target);
        this.socketPath = parsed.data.socketPath;
        this.timeoutMs = parsed.data.timeoutMs ?? 9000;
        this.maxOutputBytes = parsed.data.maxOutputBytes ?? 65536;
    }

    /** Rechecks authorization before dispatch, throughout the body, and immediately before returning evidence. */
    public async read(authorize: () => void): Promise<InfraAppRuntimeObservation> {
        const deadline = performance.now() + this.timeoutMs;
        authorize();
        let authorizationFailure: { error: unknown } | undefined;
        const checkAuthority = (): boolean => {
            try {
                authorize();
                return true;
            } catch (error) {
                authorizationFailure ??= { error };
                return false;
            }
        };
        const rethrowAuthorizationFailure = (): void => {
            if (authorizationFailure) throw authorizationFailure.error;
        };
        let safe = true;
        try {
            await this.validateSocket(deadline, checkAuthority);
        } catch {
            safe = false;
        }
        rethrowAuthorizationFailure();
        authorize();
        if (!safe || performance.now() >= deadline) return this.unavailable();
        const bytes = await new Promise<Buffer | null>((resolve) => {
            let finished = false;
            let operation: ClientRequest | undefined;
            let response: IncomingMessage | undefined;
            const chunks: Buffer[] = [];
            const checkActive = (): boolean => checkAuthority() && performance.now() < deadline;
            const finish = (result: Buffer | null): void => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                chunks.length = 0;
                response?.destroy();
                operation?.destroy();
                resolve(result);
            };
            const active = checkActive();
            const timer = active ? setTimeout(() => finish(null), deadline - performance.now()) : undefined;
            if (!active) {
                finish(null);
                return;
            }

            try {
                if (performance.now() >= deadline) {
                    finish(null);
                    return;
                }
                operation = request(
                    { socketPath: this.socketPath, path: "/runtime", method: "GET", agent: false, maxHeaderSize: 8192 },
                    (incoming) => {
                        if (finished) {
                            incoming.destroy();
                            return;
                        }
                        response = incoming;
                        if (
                            !checkActive() ||
                            response.statusCode !== 200 ||
                            response.headers["content-encoding"] !== undefined
                        ) {
                            finish(null);
                            return;
                        }
                        let size = 0;
                        incoming.on("data", (chunk: Buffer) => {
                            if (finished) return;
                            size += chunk.length;
                            if (!checkActive() || size > this.maxOutputBytes) finish(null);
                            else chunks.push(chunk);
                        });
                        incoming.on("end", () => {
                            if (finished) return;
                            finish(incoming.complete && checkActive() ? Buffer.concat(chunks) : null);
                        });
                        incoming.on("error", () => finish(null));
                        incoming.on("aborted", () => finish(null));
                    },
                );
                operation.on("error", () => finish(null));
                if (!checkActive()) {
                    finish(null);
                    return;
                }
                operation.end();
            } catch {
                finish(null);
            }
        });
        rethrowAuthorizationFailure();
        authorize();
        let observation = this.unavailable();
        try {
            if (!bytes || performance.now() >= deadline) throw new Error("Unavailable");
            const parsed = infraAppRuntimeObservationSchema.parse(
                JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
            );
            if (
                parsed.host === this.target.host &&
                parsed.application === this.target.application &&
                parsed.environment === this.target.environment
            )
                observation = parsed;
        } catch {}
        authorize();
        return performance.now() < deadline ? observation : this.unavailable();
    }

    private unavailable(): InfraAppRuntimeObservation {
        return {
            ...this.target,
            observedAt: new Date().toISOString(),
            result: "unavailable",
            runtime: null,
            healthHttp: "not_checked",
            applicationVersion: null,
        };
    }

    private async validateSocket(deadline: number, checkAuthority: () => boolean): Promise<void> {
        const readStat = async (path: string): Promise<Stats> => {
            if (!checkAuthority()) throw new Error("Unavailable");
            const remaining = deadline - performance.now();
            if (remaining <= 0) throw new Error("Unavailable");
            let timer: ReturnType<typeof setTimeout> | undefined;
            let outcome: { success: true; stat: Stats } | { success: false; error: unknown };
            try {
                // Bound each OS operation, not an async traversal that could continue after timeout.
                outcome = {
                    success: true,
                    stat: await Promise.race([
                        lstat(path),
                        new Promise<never>((_resolve, reject) => {
                            timer = setTimeout(() => reject(new Error("Unavailable")), remaining);
                        }),
                    ]),
                };
            } catch (error) {
                outcome = { success: false, error };
            } finally {
                clearTimeout(timer);
            }
            // Authority/deadline failures still override metadata failures, including falsy rejections.
            if (!checkAuthority() || performance.now() >= deadline) throw new Error("Unavailable");
            if (!outcome.success) throw outcome.error;
            return outcome.stat;
        };
        let current = "";
        for (const part of this.socketPath.slice(1).split("/")) {
            current += "/" + part;
            if ((await readStat(current)).isSymbolicLink()) throw new Error("Unavailable");
        }
        const uid = process.getuid!();
        const parent = await readStat(dirname(this.socketPath));
        if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o777) !== 0o700) {
            throw new Error("Unavailable");
        }
        const stat = await readStat(this.socketPath);
        if (!stat.isSocket() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) throw new Error("Unavailable");
    }
}
