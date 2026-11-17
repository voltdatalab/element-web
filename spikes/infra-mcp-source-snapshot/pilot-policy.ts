/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { lstatSync } from "node:fs";
import nodePath from "node:path";
import { z } from "zod";

import { LocalOAuthProvider } from "./LocalOAuthProvider.ts";
import { parseOAuthPersistenceState } from "./OAuthPersistenceValidation.ts";
import type { OAuthStateStore } from "./OAuthStateStore.ts";
import type { PilotConfiguration } from "./pilotConfiguration.ts";
import type { PilotControlAction, PilotControlStatus } from "./pilot-control-types.ts";
import { infraRuntimeScope } from "./infraRuntimeTypes.ts";
import { readPrivatePilotJson, writePilotPolicyJson } from "./pilot-private-json.ts";

/** Capture only the store's public binding and reconcile the complete maximum policy before any listener exists. */
export function createPilotPolicy(
    config: PilotConfiguration,
    store: OAuthStateStore,
): { provider: LocalOAuthProvider; control: (action: PilotControlAction) => PilotControlStatus } {
    const scope = infraRuntimeScope(config.target);
    const subject = JSON.stringify([config.actorMxid, config.publicClient.clientId]);
    const path = nodePath.join(config.stateDirectory, "policy.json");
    const identity = {
        version: 1 as const,
        actorMxid: config.actorMxid,
        clientId: config.publicClient.clientId,
        scope,
    };
    const marker =
        lstatSync(path, { throwIfNoEntry: false }) &&
        z
            .strictObject({
                version: z.literal(1),
                actorMxid: z.string().min(1).max(255),
                clientId: z.string().min(1).max(256),
                scope: z.string().min(1).max(128),
                enabled: z.boolean(),
            })
            .parse(readPrivatePilotJson(path));
    let binding: string | undefined;
    let requireExisting = Boolean(marker);
    const load = (key: string): unknown => {
        const loaded = store.load(key);
        // A policy marker or a completed snapshot identifies an installation, even when disabled.
        if (loaded === undefined && requireExisting) throw new Error("Pilot unavailable");
        if (loaded !== undefined) requireExisting = true;
        return loaded;
    };
    const provider = new LocalOAuthProvider({
        resource: new URL("/mcp", config.publicBaseUrl),
        issuer: new URL(config.publicBaseUrl),
        stateStore: {
            load: (key) => {
                if (binding !== undefined && binding !== key) throw new Error("Pilot unavailable");
                binding = key;
                return load(key);
            },
            save: (key, state) => {
                if (binding !== key) throw new Error("Pilot unavailable");
                store.save(key, state);
                requireExisting = true;
            },
        },
        clients: [
            {
                client_id: config.publicClient.clientId,
                client_name: config.publicClient.clientName,
                redirect_uris: [config.publicClient.redirectUri],
                token_endpoint_auth_method: "none",
            },
        ],
    });
    if (!binding) throw new Error("Pilot unavailable");
    const read = (): ReturnType<typeof parseOAuthPersistenceState>["grants"] => {
        const loaded = load(binding!);
        return loaded === undefined ? [] : parseOAuthPersistenceState(loaded).grants;
    };
    const samePolicy =
        marker &&
        marker.actorMxid === identity.actorMxid &&
        marker.clientId === identity.clientId &&
        marker.scope === scope;
    const grants = read();
    // For the same identity, a marker can veto authority, never recreate a removed or mismatched grant.
    const enabled = samePolicy
        ? marker.enabled &&
          grants.some(([key, grant]) => key === subject && grant.scopes.length === 1 && grant.scopes[0] === scope)
        : true;
    for (const [key, grant] of grants) {
        const [actor, client] = JSON.parse(key) as [string, string];
        if (!enabled || key !== subject || grant.scopes.length !== 1 || grant.scopes[0] !== scope)
            provider.setGrant(actor, client, []);
    }
    provider.setGrant(config.actorMxid, config.publicClient.clientId, enabled ? [scope] : []);
    const status = (): PilotControlStatus => {
        const grants = read();
        if (grants.some(([key, grant]) => key !== subject || grant.scopes.length !== 1 || grant.scopes[0] !== scope))
            throw new Error("Pilot unavailable");
        const scopes = grants.find(([key]) => key === subject)?.[1].scopes ?? [];
        return { enabled: scopes.length === 1, scopes: [...scopes], client: { ...config.publicClient } };
    };
    if (status().enabled !== enabled) throw new Error("Pilot unavailable");
    // Commit a replacement identity only after every reconciliation read and grant write succeeds.
    if (!samePolicy) writePilotPolicyJson(path, { ...identity, enabled });
    const control = (action: PilotControlAction): PilotControlStatus => {
        if (action === "status") return status();
        if (action !== "revoke" && action !== "restore") throw new Error("Pilot unavailable");
        const desired = action === "restore";
        if (!desired) {
            // Write disable intent first: a crash before setGrant is repaired before the next listen.
            try {
                writePilotPolicyJson(path, { ...identity, enabled: false });
            } catch (error) {
                provider.setGrant(config.actorMxid, config.publicClient.clientId, []);
                throw error;
            }
        }
        try {
            provider.setGrant(config.actorMxid, config.publicClient.clientId, desired ? [scope] : []);
            const current = status();
            if (current.enabled !== desired) throw new Error("Pilot unavailable");
            const confirmed = status();
            if (confirmed.enabled !== desired) throw new Error("Pilot unavailable");
            // Keep disable intent durable until even the final readback has confirmed the restored grant.
            if (desired) writePilotPolicyJson(path, { ...identity, enabled: true });
            return confirmed;
        } catch (error) {
            if (desired) {
                // Any unconfirmed restore must revoke live authority as well as restart intent.
                // Even a blocked marker write must reach setGrant; store failure makes the provider fail closed.
                try {
                    writePilotPolicyJson(path, { ...identity, enabled: false });
                } finally {
                    provider.setGrant(config.actorMxid, config.publicClient.clientId, []);
                }
            }
            throw error;
        }
    };
    return { provider, control };
}
