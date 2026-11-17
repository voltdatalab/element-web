/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import type { OAuthPersistenceState } from "./OAuthPersistence-types.ts";

const digest = /^[a-f0-9]{64}$/;
const nonce = /^[A-Za-z0-9_-]{43}$/;
const collections = ["grants", "pending", "codes", "access", "refresh", "families"] as const;

function invalid(): never {
    throw new Error("Invalid OAuth persistence state");
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
    if (
        required.some((key) => !(key in value)) ||
        Object.keys(value).some((key) => ![...required, ...optional].includes(key))
    )
        invalid();
}

function text(value: unknown, maximum: number, pattern?: RegExp): value is string {
    return (
        typeof value === "string" && value.length > 0 && value.length <= maximum && (!pattern || pattern.test(value))
    );
}

function scopes(value: unknown): void {
    if (
        !Array.isArray(value) ||
        !value.length ||
        value.length > 32 ||
        new Set(value).size !== value.length ||
        !value.every((scope) => text(scope, 128, /^[\x21\x23-\x5B\x5D-\x7E]+$/))
    )
        invalid();
}

function deadline(value: unknown): void {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 253402387199) invalid();
}

/** Validate the complete snapshot before adopting any authorization, optionally against the provider configuration. */
export function parseOAuthPersistenceState(
    value: unknown,
    context?: { resource: string; redirects: ReadonlyMap<string, readonly string[]> },
): OAuthPersistenceState {
    const root = record(value);
    keys(root, ["version", ...collections]);
    if (root.version !== 1) invalid();
    for (const collection of collections) {
        const entries = root[collection];
        if (!Array.isArray(entries) || entries.length > 1000) invalid();
        const seen = new Set<string>();
        for (const entry of entries) {
            if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || seen.has(entry[0]))
                invalid();
            const [key, raw] = entry;
            seen.add(key);
            const item = record(raw);
            if (!text(item.clientId, 256) || (context && !context.redirects.has(item.clientId))) invalid();
            if (collection === "grants") {
                keys(item, ["clientId", "scopes", "generation"]);
                let subject: unknown;
                try {
                    subject = JSON.parse(key);
                } catch {
                    invalid();
                }
                if (
                    !Array.isArray(subject) ||
                    subject.length !== 2 ||
                    !text(subject[0], 256) ||
                    subject[1] !== item.clientId ||
                    JSON.stringify(subject) !== key ||
                    !text(item.generation, 43, nonce)
                )
                    invalid();
                scopes(item.scopes);
                continue;
            }
            deadline(item.expiresAt);
            if (collection === "families") {
                keys(item, ["clientId", "expiresAt", "revoked"]);
                if (!nonce.test(key) || typeof item.revoked !== "boolean") invalid();
                continue;
            }
            if (!digest.test(key) || !text(item.resource, 2048) || (context && item.resource !== context.resource))
                invalid();
            scopes(item.scopes);
            const common = ["clientId", "scopes", "resource", "expiresAt"];
            if (collection === "pending" || collection === "codes") {
                if (
                    !text(item.redirectUri, 2048) ||
                    !text(item.challenge, 43, nonce) ||
                    (context && !context.redirects.get(item.clientId as string)!.includes(item.redirectUri))
                )
                    invalid();
            }
            if (collection === "pending") {
                keys(item, [...common, "redirectUri", "challenge", "cookieHash", "csrf"], ["state"]);
                if (
                    !text(item.cookieHash, 64, digest) ||
                    !text(item.csrf, 43, nonce) ||
                    (item.state !== undefined && (typeof item.state !== "string" || item.state.length > 2048))
                )
                    invalid();
                continue;
            }
            if (!text(item.userId, 256) || !text(item.generation, 43, nonce)) invalid();
            if (collection === "codes") {
                keys(item, [...common, "userId", "generation", "redirectUri", "challenge"]);
                continue;
            }
            keys(item, [...common, "userId", "generation", "familyId", ...(collection === "refresh" ? ["used"] : [])]);
            if (!text(item.familyId, 43, nonce) || (collection === "refresh" && typeof item.used !== "boolean"))
                invalid();
        }
    }
    // All record shapes are checked above; only now are typed cross-record lookups safe.
    const state = value as OAuthPersistenceState;
    const families = new Map(state.families);
    for (const [, token] of [...state.access, ...state.refresh]) {
        const family = families.get(token.familyId);
        if (
            !family ||
            family.clientId !== token.clientId ||
            token.expiresAt > family.expiresAt ||
            ("used" in token && token.expiresAt !== family.expiresAt)
        )
            invalid();
    }
    return structuredClone(state);
}
