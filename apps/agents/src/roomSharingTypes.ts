/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

/** An exact room audience; a new revision always starts a fresh conversation. */
export interface RoomGrant {
    agent_id: string;
    room_id: string;
    revision: number;
    state: "checking" | "active" | "revoked" | "suspended";
    audience_json: string;
    sync_token: string | null;
    await_room: number;
}

/** Shared-room outbox, deliberately separate from the private DM and its artifacts. */
export interface RoomTurn {
    agent_id: string;
    event_id: string;
    room_id: string;
    revision: number;
    sender: string;
    body: string;
    answer: string | null;
    state: "pending" | "sending" | "delivered" | "blocked" | "uncertain";
    encrypted_json: string | null;
}

/** Durable owner command and acknowledgement; never submitted to the model. */
export interface RoomControl {
    agent_id: string;
    event_id: string;
    room_id: string;
    revision: number;
    kind: "share" | "revoke" | "help";
    reply: string | null;
    delivered: number;
}

/** SDK events accepted only after successful room-event decryption. */
export interface SharedMessage {
    event_id: string;
    sender: string;
    type?: string;
    state_key?: string;
    content: {
        "body"?: string;
        "msgtype"?: string;
        "membership"?: string;
        "m.mentions"?: { user_ids?: string[] };
    };
}

/** Only the sync fields needed for the admission boundary and access invalidation. */
export interface SharingSync {
    next_batch: string;
    rooms?: {
        join?: Record<
            string,
            {
                state?: { events?: SharedMessage[] };
                timeline?: { events?: SharedMessage[]; limited?: boolean };
            }
        >;
        leave?: Record<string, unknown>;
    };
}

/** Minimal lifecycle exposed to the room gateway. */
export interface SharedConversation {
    reply(eventId: string, text: string): Promise<string>;
    abort(): Promise<void>;
    close(): Promise<void>;
}
