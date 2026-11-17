/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { constants, lstatSync, mkdirSync, readdirSync, openSync, closeSync, fsyncSync, type Stats } from "node:fs";

import type { OAuthStateStore } from "./OAuthStateStore.ts";
import type { OAuthPersistenceState } from "./OAuthPersistence-types.ts";
import { parseOAuthPersistenceState } from "./OAuthPersistenceValidation.ts";

const applicationId = 0x564f4155;
const schema = "CREATE TABLE oauth_state (id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL, snapshot TEXT)";

function noSymlinks(path: string): void {
    for (let current = path; ; current = dirname(current)) {
        if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
            throw new Error("Unsafe OAuth storage symlink");
        if (current === dirname(current)) break;
    }
}

function privateStat(path: string, directory: boolean): Stats {
    const stat = lstatSync(path);
    if (
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600) ||
        (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    )
        throw new Error("Unsafe OAuth storage ownership, type or permissions");
    return stat;
}

/** Synchronous SQLite snapshot store. Its dedicated private directory is never the API database directory. */
export class SqliteOAuthStateStore implements OAuthStateStore {
    private readonly db: DatabaseSync;
    private closed = false;
    private readonly directory: string;
    private readonly path: string;
    private readonly directoryIdentity: Stats;
    private readonly fileIdentity: Stats;
    private lastFileChange?: string;

    public constructor(options: { directory: string }) {
        this.directory = resolve(options.directory);
        this.path = join(this.directory, "oauth-state.sqlite");
        noSymlinks(this.directory);
        if (!lstatSync(this.directory, { throwIfNoEntry: false })) mkdirSync(this.directory, { mode: 0o700 });
        this.directoryIdentity = privateStat(this.directory, true);
        this.checkEntries();
        const fresh = !lstatSync(this.path, { throwIfNoEntry: false });
        if (fresh) {
            if (readdirSync(this.directory).length) throw new Error("Unowned OAuth storage files");
            const fd = openSync(
                this.path,
                constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
                0o600,
            );
            closeSync(fd);
            const dirFd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY);
            try {
                fsyncSync(dirFd);
            } finally {
                closeSync(dirFd);
            }
        }
        this.fileIdentity = privateStat(this.path, false);
        if (!fresh && this.fileIdentity.size < 16) throw new Error("Not an OAuth SQLite database");
        // Let SQLite validate existing files and manage every descriptor: an independent close would
        // release all fcntl locks for this inode in the process, including locks held by other connections.
        this.db = new DatabaseSync(this.path);
        try {
            // DELETE journaling plus a retained EXCLUSIVE connection lock excludes other writers without stale lock files.
            this.db.exec(
                "PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA trusted_schema=OFF; BEGIN EXCLUSIVE;",
            );
            if (fresh) {
                this.db.exec(`PRAGMA application_id=${applicationId}; PRAGMA user_version=1; ${schema};`);
            } else {
                this.checkSchema();
            }
            const mode = this.db.prepare("PRAGMA journal_mode").get();
            if (mode?.journal_mode !== "delete") throw new Error("OAuth database must use DELETE journaling");
            this.db.exec("COMMIT; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;");
            this.markFileChange();
            this.check();
            const row = this.db.prepare("SELECT binding, snapshot FROM oauth_state WHERE id=1").get();
            if (row) {
                if (typeof row.binding !== "string" || !/^[a-f0-9]{64}$/.test(row.binding))
                    throw new Error("Invalid OAuth state binding");
                this.decode(row.snapshot);
            }
        } catch (error) {
            this.db.close();
            this.closed = true;
            throw error;
        }
    }

    /** Permanently bind this store to the provider configuration before reading any state. */
    public load(binding: string): OAuthPersistenceState | undefined {
        this.check();
        if (!/^[a-f0-9]{64}$/.test(binding)) throw new Error("Invalid OAuth state binding");
        const row = this.db.prepare("SELECT binding, snapshot FROM oauth_state WHERE id=1").get();
        if (!row) {
            this.db.prepare("INSERT INTO oauth_state (id,binding,snapshot) VALUES (1,?,NULL)").run(binding);
            this.markFileChange();
            return undefined;
        }
        if (row.binding !== binding) throw new Error("Incompatible OAuth state binding");
        return this.decode(row.snapshot);
    }

    /** Commit the entire authorization transition atomically before returning. */
    public save(binding: string, state: OAuthPersistenceState): void {
        this.load(binding);
        const snapshot = JSON.stringify(parseOAuthPersistenceState(state));
        if (Buffer.byteLength(snapshot) > 32 * 1024 * 1024) throw new Error("OAuth snapshot too large");
        this.db.prepare("UPDATE oauth_state SET snapshot=? WHERE id=1 AND binding=?").run(snapshot, binding);
        this.markFileChange();
    }

    /** Release the connection and its writer lock; safe to call more than once. */
    public close(): void {
        if (this.closed) return;
        this.closed = true;
        this.db.close();
    }

    private checkEntries(): void {
        for (const name of readdirSync(this.directory)) {
            if (!["oauth-state.sqlite", "oauth-state.sqlite-journal"].includes(name))
                throw new Error("Unowned OAuth storage entry");
            privateStat(join(this.directory, name), false);
        }
    }

    private check(): void {
        if (this.closed) throw new Error("OAuth state store closed");
        noSymlinks(this.directory);
        const directory = privateStat(this.directory, true);
        const file = privateStat(this.path, false);
        if (this.lastFileChange !== undefined && this.lastFileChange !== this.fileChange(file))
            throw new Error("OAuth database changed outside its connection");
        if (
            directory.ino !== this.directoryIdentity.ino ||
            directory.dev !== this.directoryIdentity.dev ||
            file.ino !== this.fileIdentity.ino ||
            file.dev !== this.fileIdentity.dev
        )
            throw new Error("OAuth storage replaced");
        this.checkEntries();
        this.checkSchema();
    }

    private decode(snapshot: unknown): OAuthPersistenceState | undefined {
        if (snapshot === null) return undefined;
        if (typeof snapshot !== "string" || Buffer.byteLength(snapshot) > 32 * 1024 * 1024)
            throw new Error("Invalid OAuth state snapshot");
        return parseOAuthPersistenceState(JSON.parse(snapshot));
    }

    private fileChange(stat: Stats): string {
        return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    }

    private markFileChange(): void {
        this.lastFileChange = this.fileChange(privateStat(this.path, false));
    }

    private checkSchema(): void {
        const id = this.db.prepare("PRAGMA application_id").get();
        const version = this.db.prepare("PRAGMA user_version").get();
        const objects = this.db.prepare("SELECT type,name,sql FROM sqlite_master").all();
        const integrity = this.db.prepare("PRAGMA quick_check").get();
        if (
            id?.application_id !== applicationId ||
            version?.user_version !== 1 ||
            integrity?.quick_check !== "ok" ||
            objects.length !== 1 ||
            objects[0].type !== "table" ||
            objects[0].name !== "oauth_state" ||
            objects[0].sql !== schema ||
            Number(this.db.prepare("SELECT count(*) AS count FROM oauth_state").get()?.count ?? 2) > 1
        )
            throw new Error("Incompatible or corrupt OAuth SQLite database");
    }
}
