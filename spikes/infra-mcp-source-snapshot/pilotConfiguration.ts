/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { dirname, isAbsolute } from "node:path";
import { z } from "zod";

import { MatrixIdentityVerifier } from "./MatrixIdentityVerifier.ts";
import { infraRuntimeScope } from "./infraRuntimeTypes.ts";
import { readPrivatePilotJson } from "./pilot-private-json.ts";

const privatePath = z
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
const socketPath = privatePath.refine((path) => Buffer.byteLength(path) <= 103);
const literalUrl = z
    .string()
    .max(2048)
    .refine((value) => {
        try {
            const url = new URL(value);
            return (
                url.href === value &&
                !url.username &&
                !url.password &&
                !/[?#]/.test(value) &&
                !value.split("/")[2].includes("@")
            );
        } catch {
            return false;
        }
    });
const slug = z
    .string()
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
const configurationSchema = z.strictObject({
    publicBaseUrl: literalUrl,
    listenHost: z.enum(["127.0.0.1", "0.0.0.0"]),
    listenPort: z.number().int().min(1).max(65535),
    transportMode: z.enum(["loopback", "https-proxy"]).default("loopback"),
    privateContainerProxy: z.boolean().default(false),
    matrixHomeserverUrl: literalUrl,
    actorMxid: z.string().min(1).max(255),
    publicClient: z.strictObject({
        clientId: z
            .string()
            .min(1)
            .max(256)
            .regex(/^[A-Za-z0-9._-]+$/),
        clientName: z
            .string()
            .min(1)
            .max(128)
            .regex(/^[^\x00-\x1f\x7f]+$/),
        redirectUri: literalUrl,
    }),
    target: z.strictObject({ host: slug, application: slug, environment: z.enum(["staging", "production"]) }),
    observerSocketPath: socketPath,
    stateDirectory: privatePath,
    operatorSocketPath: socketPath,
});

/** Secret-free, installation-owned policy. No discovery, environment fallback or caller-selected target. */
export type PilotConfiguration = Readonly<
    Omit<z.infer<typeof configurationSchema>, "target" | "publicClient"> & {
        target: Readonly<z.infer<typeof configurationSchema>["target"]>;
        publicClient: Readonly<z.infer<typeof configurationSchema>["publicClient"]>;
    }
>;

/** Load at most 16 KiB of strict UTF-8 JSON from an owner-private, non-symlink installation file. */
export function readPilotConfiguration(path: string): PilotConfiguration {
    try {
        return parsePilotConfiguration(readPrivatePilotJson(path));
    } catch {
        throw new Error("Invalid pilot configuration");
    }
}

/** Validate literal private configuration and return an independent immutable policy. */
export function parsePilotConfiguration(value: unknown): PilotConfiguration {
    try {
        const config = configurationSchema.parse(value);
        const base = new URL(config.publicBaseUrl);
        const homeserver = new URL(config.matrixHomeserverUrl);
        const callback = new URL(config.publicClient.redirectUri);
        if (base.pathname !== "/" || homeserver.protocol !== "https:") throw new Error();
        if (
            callback.protocol !== "https:" &&
            !(callback.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(callback.hostname))
        )
            throw new Error();
        if (config.transportMode === "https-proxy") {
            if (base.protocol !== "https:") throw new Error();
        } else if (
            base.protocol !== "http:" ||
            base.hostname !== "127.0.0.1" ||
            Number(base.port || "80") !== config.listenPort
        )
            throw new Error();
        if (
            config.privateContainerProxy !== (config.listenHost === "0.0.0.0") ||
            (config.privateContainerProxy && config.transportMode !== "https-proxy")
        )
            throw new Error();
        const directories = [
            config.stateDirectory,
            dirname(config.operatorSocketPath),
            dirname(config.observerSocketPath),
        ];
        if (
            directories.some((directory, index) =>
                directories.some(
                    (other, j) => index !== j && (directory === other || directory.startsWith(other + "/")),
                ),
            )
        )
            throw new Error();
        if (infraRuntimeScope(config.target).length > 128) throw new Error();
        // Reuse the identity verifier's literal MXID validation without making a network request.
        new MatrixIdentityVerifier({ homeserver, allowedUsers: new Set([config.actorMxid]) });
        return Object.freeze({
            ...config,
            target: Object.freeze(config.target),
            publicClient: Object.freeze(config.publicClient),
        });
    } catch {
        throw new Error("Invalid pilot configuration");
    }
}
