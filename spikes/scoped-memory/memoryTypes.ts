/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

/** Trusted fixture-control-plane grant, never an agent-selected scope. */
export interface MemoryScope {
    id: string;
    kind: "dm" | "shared" | "restricted";
    conversationId?: string;
    readers: string[];
    agents: string[];
}

/** Registered destination and its entire audience, supplied by the control plane. */
export interface MemoryConversation {
    id: string;
    audience: string[];
    agents: string[];
    scopes: string[];
}

/** Synthetic source note. Notes are append-only; corrections use supersedes. */
export interface MemoryNote {
    id: string;
    scopeId: string;
    text: string;
    sourceId: string;
    sourceVersion: number;
    supersedes?: string;
    parents?: readonly string[];
}

/** Identity-bearing handle: structurally identical objects are not accepted. */
export type MemoryTurn = Readonly<Record<string, never>>;

/** Authorized text with source references; not a model answer. */
export interface MemoryResult {
    readonly notes: readonly Readonly<MemoryNote>[];
    readonly text: string;
}
