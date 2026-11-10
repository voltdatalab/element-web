/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

/** UTF-8 file verified after reading it from the agent's microVM. */
export interface MachineArtifact {
    path: string;
    content: string;
    sha256: string;
}
