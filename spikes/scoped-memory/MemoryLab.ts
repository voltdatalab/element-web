/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { DatabaseSync } from "node:sqlite";
import type { MemoryConversation, MemoryNote, MemoryResult, MemoryScope, MemoryTurn } from "./memoryTypes.ts";

type Configuration<T> = { revision: number; value: T };
type StoredScope = MemoryScope & { dmOwner?: string; dmAgent?: string };
type TurnState = {
    conversationId: string;
    conversationRevision: number;
    scopeRevisions: Map<string, number>;
};

/** Standalone synthetic memory experiment. Not imported by the application. */
export class MemoryLab {
    private readonly database: DatabaseSync;
    private readonly turns = new WeakMap<MemoryTurn, TurnState>();
    private readonly results = new WeakMap<MemoryResult, MemoryTurn>();

    public constructor(filename: string) {
        this.database = new DatabaseSync(filename);
        this.database.exec(`
            CREATE TABLE IF NOT EXISTS configuration (
                kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
                PRIMARY KEY (kind, id)
            );
            CREATE TABLE IF NOT EXISTS notes (
                id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, body TEXT NOT NULL,
                source_id TEXT NOT NULL, source_version INTEGER NOT NULL,
                supersedes TEXT, parents TEXT NOT NULL
            );
        `);
    }

    private configuration<T>(kind: string, id: string): Configuration<T> | undefined {
        const row = this.database
            .prepare("SELECT revision, payload FROM configuration WHERE kind = ? AND id = ?")
            .get(kind, id) as { revision: number; payload: string } | undefined;
        return row ? { revision: row.revision, value: JSON.parse(row.payload) as T } : undefined;
    }

    private configure(kind: string, id: string, value: unknown): void {
        this.database
            .prepare(`INSERT INTO configuration (kind, id, revision, payload) VALUES (?, ?, 1, ?)
            ON CONFLICT (kind, id) DO UPDATE SET revision = revision + 1, payload = excluded.payload`)
            .run(kind, id, JSON.stringify(value));
    }

    /** Change fixture authorization; every change invalidates existing turns. */
    public setScope(scope: MemoryScope): void {
        const previous = this.configuration<StoredScope>("scope", scope.id)?.value;
        if (
            !this.identifier(scope.id) ||
            !["dm", "shared", "restricted"].includes(scope.kind) ||
            !this.identifiers(scope.readers) ||
            !this.identifiers(scope.agents) ||
            (previous && (previous.kind !== scope.kind || previous.conversationId !== scope.conversationId))
        )
            throw new Error("invalid_configuration");
        const dmOwner = previous?.dmOwner ?? scope.readers[0];
        const dmAgent = previous?.dmAgent ?? scope.agents[0];
        if (
            scope.kind === "dm" &&
            (!this.identifier(scope.conversationId) ||
                !dmOwner ||
                !dmAgent ||
                scope.readers.some((reader) => reader !== dmOwner) ||
                scope.agents.some((agent) => agent !== dmAgent))
        )
            throw new Error("invalid_configuration");
        this.configure("scope", scope.id, scope.kind === "dm" ? { ...scope, dmOwner, dmAgent } : scope);
    }

    private identifier(value: unknown): value is string {
        return typeof value === "string" && value.trim().length > 0;
    }

    private identifiers(values: readonly string[]): boolean {
        return Array.isArray(values) && values.every((value) => this.identifier(value));
    }

    /** Register a destination instead of accepting caller-selected recipients. */
    public setConversation(conversation: MemoryConversation): void {
        if (
            !this.identifier(conversation.id) ||
            !this.identifiers(conversation.audience) ||
            !this.identifiers(conversation.agents) ||
            !this.identifiers(conversation.scopes) ||
            !conversation.audience.length ||
            !conversation.agents.length ||
            conversation.scopes.some((id) => !this.configuration("scope", id))
        )
            throw new Error("invalid_configuration");
        this.configure("conversation", conversation.id, conversation);
    }

    /** Append a synthetic source through the trusted fixture control plane. */
    public addNote(note: MemoryNote): void {
        if (
            !note.id ||
            !note.sourceId ||
            !Number.isSafeInteger(note.sourceVersion) ||
            note.sourceVersion < 1 ||
            note.parents?.length ||
            !this.configuration<MemoryScope>("scope", note.scopeId)
        )
            throw new Error("invalid_source");
        if (note.supersedes) {
            const previous = this.note(note.supersedes, note.scopeId);
            if (
                !previous ||
                previous.parents?.length ||
                !this.current(previous.id, note.scopeId) ||
                previous.sourceId !== note.sourceId ||
                previous.sourceVersion >= note.sourceVersion
            )
                throw new Error("invalid_source");
        }
        this.insert(note);
    }

    private insert(note: MemoryNote): void {
        this.database
            .prepare(`INSERT INTO notes
            (id, scope_id, body, source_id, source_version, supersedes, parents) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(
                note.id,
                note.scopeId,
                note.text,
                note.sourceId,
                note.sourceVersion,
                note.supersedes ?? null,
                JSON.stringify(note.parents ?? []),
            );
    }

    private note(id: string, scopeId: string): MemoryNote | undefined {
        const row = this.database
            .prepare(`SELECT id, scope_id, body, source_id, source_version,
            supersedes, parents FROM notes WHERE id = ? AND scope_id = ?`)
            .get(id, scopeId) as
            | {
                  id: string;
                  scope_id: string;
                  body: string;
                  source_id: string;
                  source_version: number;
                  supersedes: string | null;
                  parents: string;
              }
            | undefined;
        if (!row) return undefined;
        return Object.freeze({
            id: row.id,
            scopeId: row.scope_id,
            text: row.body,
            sourceId: row.source_id,
            sourceVersion: row.source_version,
            ...(row.supersedes ? { supersedes: row.supersedes } : {}),
            parents: Object.freeze(JSON.parse(row.parents) as string[]),
        });
    }

    private current(id: string, scopeId: string, ancestors = new Set<string>()): boolean {
        if (ancestors.has(id)) return false;
        const row = this.database
            .prepare("SELECT parents FROM notes WHERE id = ? AND scope_id = ?")
            .get(id, scopeId) as { parents: string } | undefined;
        if (!row || this.database.prepare("SELECT 1 FROM notes WHERE scope_id = ? AND supersedes = ?").get(scopeId, id))
            return false;
        ancestors.add(id);
        return (JSON.parse(row.parents) as string[]).every((parent) =>
            this.current(parent, scopeId, new Set(ancestors)),
        );
    }

    /** Build an extractive provenance fixture, not a semantic summary or token optimization. */
    public createDigest(id: string, scopeId: string, parents: readonly string[]): void {
        if (!id || !parents.length) throw new Error("invalid_source");
        const sources = parents.map((parent) => this.note(parent, scopeId));
        if (sources.some((source) => !source || !this.current(source.id, scopeId))) throw new Error("invalid_source");
        this.insert({
            id,
            scopeId,
            sourceId: `digest:${id}`,
            sourceVersion: 1,
            text: sources.map((source) => source!.text).join("\n"),
            parents,
        });
    }

    /** Bind a turn to authoritative destination, audience, agent and grant revisions. */
    public beginTurn(conversationId: string, agentId: string, requesterId: string): MemoryTurn {
        const configuration = this.configuration<MemoryConversation>("conversation", conversationId);
        const conversation = configuration?.value;
        if (
            !configuration ||
            !conversation ||
            !conversation.audience.length ||
            !conversation.audience.includes(requesterId) ||
            !conversation.agents.includes(agentId)
        ) {
            throw new Error("access_denied");
        }
        const scopeRevisions = new Map<string, number>();
        for (const id of conversation.scopes) {
            const scope = this.configuration<MemoryScope>("scope", id);
            if (
                scope &&
                scope.value.agents.includes(agentId) &&
                conversation.audience.every((reader) => scope.value.readers.includes(reader)) &&
                (scope.value.kind !== "dm" || scope.value.conversationId === conversationId)
            ) {
                scopeRevisions.set(id, scope.revision);
            }
        }
        const turn = Object.freeze({});
        this.turns.set(turn, { conversationId, conversationRevision: configuration.revision, scopeRevisions });
        return turn;
    }

    private authorize(turn: MemoryTurn): TurnState {
        const state = this.turns.get(turn);
        if (!state) throw new Error("access_denied");
        if (
            this.configuration("conversation", state.conversationId)?.revision !== state.conversationRevision ||
            [...state.scopeRevisions].some(([id, revision]) => this.configuration("scope", id)?.revision !== revision)
        )
            throw new Error("access_revoked");
        return state;
    }

    /** Search only authorized partitions; denied scopes never enter the content query. */
    public search(turn: MemoryTurn, query: string): MemoryResult {
        const state = this.authorize(turn);
        const notes: MemoryNote[] = [];
        for (const scopeId of state.scopeRevisions.keys()) {
            const rows = this.database
                .prepare(`SELECT id FROM notes
                WHERE scope_id = ? AND instr(lower(body), lower(?)) > 0 ORDER BY id`)
                .all(scopeId, query) as { id: string }[];
            for (const row of rows) if (this.current(row.id, scopeId)) notes.push(this.note(row.id, scopeId)!);
        }
        const result = Object.freeze({
            notes: Object.freeze(notes),
            text: JSON.stringify({ untrustedSources: notes }),
        });
        this.results.set(result, turn);
        return result;
    }

    /** Recheck access immediately before a synchronous, text-only fixture handoff. */
    public dispatch(turn: MemoryTurn, result: MemoryResult, sink: (text: string) => void): void {
        this.authorize(turn);
        if (this.results.get(result) !== turn) throw new Error("access_denied");
        if (result.notes.some((note) => !this.current(note.id, note.scopeId))) throw new Error("stale_source");
        sink(result.text);
    }

    /** Release only this fixture database. */
    public close(): void {
        this.database.close();
    }
}
