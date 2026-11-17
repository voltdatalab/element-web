/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** The only operator actions; neither the target nor authorization policy is an RPC parameter. */
export type PilotControlAction = "status" | "revoke" | "restore";

/** Minimal projection of the single configured client's current persisted grant. */
export interface PilotControlStatus {
    enabled: boolean;
    scopes: string[];
    client: { clientId: string; clientName: string; redirectUri: string };
}
