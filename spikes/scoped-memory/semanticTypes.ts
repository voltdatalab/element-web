/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

/** Stateless local encoder; callers supply query:/passage: prefixes and authorized text only. */
export interface TextEmbedder {
    encode: (texts: readonly string[]) => Promise<readonly (readonly number[])[]>;
    dispose: () => Promise<void>;
}
