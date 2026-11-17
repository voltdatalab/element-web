/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import type { OAuthPersistenceState } from "./OAuthPersistence-types.ts";

/**
 * Synchronous, single-writer OAuth persistence. Bind permanently on first load/save;
 * throw on incompatible binding, corruption, closure or failed durable commit.
 * A successful save atomically replaces the entire snapshot before returning.
 */
export interface OAuthStateStore {
    load(binding: string): unknown | undefined;
    save(binding: string, state: OAuthPersistenceState): void;
}
