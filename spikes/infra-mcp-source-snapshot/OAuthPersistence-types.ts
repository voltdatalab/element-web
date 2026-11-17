/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

/** Resource/client/scope binding shared by persisted authorization records. */
export type OAuthPersistenceBinding = { clientId: string; scopes: string[]; resource: string };
/** Browser consent; bearer credentials and request IDs are stored only as hashes. */
export type OAuthPersistencePending = OAuthPersistenceBinding & {
    redirectUri: string;
    state?: string;
    challenge: string;
    expiresAt: number;
    cookieHash: string;
    csrf: string;
};
/** A single-use code, indexed by its SHA-256 hash. */
export type OAuthPersistenceCode = OAuthPersistenceBinding & {
    userId: string;
    generation: string;
    redirectUri: string;
    challenge: string;
    expiresAt: number;
};
/** A token, indexed by its SHA-256 hash and tied to a finite family. */
export type OAuthPersistenceToken = OAuthPersistenceBinding & {
    userId: string;
    generation: string;
    familyId: string;
    expiresAt: number;
};
/** Used refresh hashes remain until the original family deadline. */
export type OAuthPersistenceRefresh = OAuthPersistenceToken & { used: boolean };
/** Revocation outlives all tokens in this fixed-deadline family. */
export type OAuthPersistenceFamily = { clientId: string; expiresAt: number; revoked: boolean };
/** Trusted grant generation; removing and recreating a grant produces a new generation. */
export type OAuthPersistenceGrant = { clientId: string; scopes: string[]; generation: string };
/** Versioned atomic snapshot. No OAuth token, code, cookie or upstream credential belongs here. */
export interface OAuthPersistenceState {
    version: 1;
    grants: [string, OAuthPersistenceGrant][];
    pending: [string, OAuthPersistencePending][];
    codes: [string, OAuthPersistenceCode][];
    access: [string, OAuthPersistenceToken][];
    refresh: [string, OAuthPersistenceRefresh][];
    families: [string, OAuthPersistenceFamily][];
}
