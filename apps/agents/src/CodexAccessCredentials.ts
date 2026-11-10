/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { readFile } from "node:fs/promises";
import type { CredentialInfo, CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";

/** Read-only lab access token. Renewal remains with the original credential owner. */
export class CodexAccessCredentials implements CredentialStore {
    private readonly path: string;

    public constructor(path: string) {
        this.path = path;
    }

    public async read(providerId: string): Promise<OAuthCredential | undefined> {
        if (providerId !== "openai-codex") return undefined;
        let value: { access?: unknown; expires?: unknown };
        try {
            value = JSON.parse(await readFile(this.path, "utf8"));
            if (
                !value ||
                typeof value.access !== "string" ||
                !value.access ||
                typeof value.expires !== "number" ||
                !Number.isFinite(value.expires)
            ) {
                throw new Error("invalid");
            }
        } catch {
            throw new Error("model_credential_invalid");
        }
        // Pi refreshes within five minutes of expiry. Never rotate a token shared with Hermes.
        if (value.expires <= Date.now() + 300_000) throw new Error("model_credential_expired");
        return { type: "oauth", access: value.access, expires: value.expires, refresh: "" };
    }

    public async list(): Promise<readonly CredentialInfo[]> {
        await this.read("openai-codex");
        return [{ providerId: "openai-codex", type: "oauth" }];
    }

    public modify(): ReturnType<CredentialStore["modify"]> {
        return Promise.reject(new Error("model_credential_read_only"));
    }

    public delete(): ReturnType<CredentialStore["delete"]> {
        return Promise.reject(new Error("model_credential_read_only"));
    }
}
