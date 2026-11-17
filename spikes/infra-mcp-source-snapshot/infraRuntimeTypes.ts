/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { z } from "zod";

const slug = z
    .string()
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
const targetSchema = z.strictObject({
    host: slug,
    application: slug,
    environment: z.enum(["staging", "production"]),
});
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
// A conservative Docker reference subset: no URLs, userinfo, whitespace, query, or fragment.
const imageRefPattern = new RegExp(
    [
        "^(",
        /(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?\/)?/.source,
        /[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*/.source,
        ")",
        /(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/.source,
    ].join(""),
);
const imageRef = z
    .string()
    .max(512)
    .regex(imageRefPattern)
    .refine((image) => {
        const repository = imageRefPattern.exec(image)?.[1];
        // The captured ASCII name includes registry/port, but excludes tag and digest.
        return repository !== undefined && repository.length <= 255;
    }, "Invalid image repository name length");
const runtimeSchema = z
    .strictObject({
        status: z.enum(["running", "degraded", "stopped", "unavailable"]),
        desiredInstances: count,
        runningInstances: count,
        runningTaskImageRefs: z.array(imageRef).max(1024).nullable(),
    })
    .superRefine((value, context) => {
        if (
            value.status === "unavailable" &&
            (value.desiredInstances !== null || value.runningInstances !== null || value.runningTaskImageRefs !== null)
        ) {
            context.addIssue({ code: "custom", message: "Unavailable runtime must preserve unknown values" });
        }
    });

/** The executor-owned logical target; host is an identifier, never a caller-selected URL. */
export interface InfraRuntimeTarget {
    host: string;
    application: string;
    environment: "staging" | "production";
}

/** Strict projected evidence; task state does not establish HTTP health or application version. */
export const infraAppRuntimeObservationSchema = z
    .strictObject({
        ...targetSchema.shape,
        observedAt: z.iso.datetime(),
        result: z.enum(["observed", "not_found", "unsupported", "auth_error", "unavailable"]),
        runtime: runtimeSchema.nullable(),
        healthHttp: z.literal("not_checked"),
        applicationVersion: z.null(),
    })
    .superRefine((value, context) => {
        if ((value.result === "observed") !== (value.runtime !== null)) {
            context.addIssue({ code: "custom", message: "Runtime evidence does not match result" });
        }
    });

/** A normalized, locally timestamped runtime observation without upstream diagnostic text. */
export type InfraAppRuntimeObservation = z.infer<typeof infraAppRuntimeObservationSchema>;

/** Read one immutable configured application, rechecking authority across asynchronous boundaries. */
export interface InfraAppRuntimeReader {
    readonly target: Readonly<InfraRuntimeTarget>;
    read: (authorize: () => void) => Promise<InfraAppRuntimeObservation>;
}

/** Captures validated literal fields without retaining or rereading caller-owned accessors. */
export function snapshotInfraRuntimeTarget(target: InfraRuntimeTarget): Readonly<InfraRuntimeTarget> {
    try {
        const parsed = targetSchema.parse(target);
        return Object.freeze({ host: parsed.host, application: parsed.application, environment: parsed.environment });
    } catch {
        throw new Error("Invalid infrastructure runtime target");
    }
}

/** Validates literal identifiers and returns the exact application/environment-specific scope. */
export function infraRuntimeScope(target: InfraRuntimeTarget): string {
    const snapshot = snapshotInfraRuntimeTarget(target);
    return `infra:runtime:read:${snapshot.host}:${snapshot.application}:${snapshot.environment}`;
}
