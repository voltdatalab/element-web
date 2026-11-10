/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type CreateAgentSnapshot,
    type CreateAgentViewModel as ViewModelContract,
} from "@element-hq/web-shared-components";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import { _t } from "../../languageHandler";
import { setDMRoom } from "../../Rooms";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import type { ViewRoomPayload } from "../../dispatcher/payloads/ViewRoomPayload";

interface Props {
    matrixClient: MatrixClient;
    onFinished: () => void;
}

interface Draft {
    key: string;
    name: string;
    description: string;
}

/** Owns a recoverable creation request, joining and opening its confirmed Matrix DM. */
export class CreateAgentViewModel extends BaseViewModel<CreateAgentSnapshot, Props> implements ViewModelContract {
    private readonly storageKey: string;
    private readonly request: Draft;
    private readonly controller = new AbortController();

    public constructor(props: Props) {
        const storageKey = `clawdia.agent-draft:${props.matrixClient.getUserId()}`;
        let draft: Draft = { key: crypto.randomUUID(), name: "", description: "" };
        const saved = sessionStorage.getItem(storageKey);
        if (saved) {
            try {
                const parsed = JSON.parse(saved) as Draft;
                if (
                    typeof parsed.name !== "string" ||
                    typeof parsed.description !== "string" ||
                    typeof parsed.key !== "string"
                )
                    throw new Error("invalid_draft");
                draft = parsed;
            } catch {
                sessionStorage.removeItem(storageKey);
            }
        }
        super(props, {
            name: draft.name,
            description: draft.description,
            busy: false,
            error: "",
            submitted: Boolean(sessionStorage.getItem(storageKey)),
        });
        this.storageKey = storageKey;
        this.request = draft;
        this.disposables.track(() => this.controller.abort());
    }

    public setName = (name: string): void => {
        this.snapshot.merge({ name });
    };
    public setDescription = (description: string): void => {
        this.snapshot.merge({ description });
    };
    public cancel = (): void => {
        this.props.onFinished();
    };

    public submit = async (): Promise<void> => {
        const { name, description, busy } = this.snapshot.current;
        if (busy || !name.trim()) return;
        // Once admitted, retries keep their original payload and idempotency key.
        if (!sessionStorage.getItem(this.storageKey)) {
            this.request.name = name.trim();
            this.request.description = description.trim();
            sessionStorage.setItem(this.storageKey, JSON.stringify(this.request));
        }
        this.snapshot.merge({ busy: true, error: "", submitted: true });
        try {
            const response = await fetch("/clawdia/agents", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${this.props.matrixClient.getAccessToken()}`,
                    "Idempotency-Key": this.request.key,
                },
                body: JSON.stringify({ name: this.request.name, description: this.request.description }),
                signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(90_000)]),
            });
            if (!response.ok) throw new Error("provisioning_failed");
            const result = (await response.json()) as { roomId: string; userId: string; status: string };
            if (result.status !== "ready" || !result.roomId?.startsWith("!") || !result.userId?.startsWith("@"))
                throw new Error("invalid_response");
            await this.props.matrixClient.joinRoom(result.roomId);
            await setDMRoom(this.props.matrixClient, result.roomId, result.userId);
            this.controller.signal.throwIfAborted();
            sessionStorage.removeItem(this.storageKey);
            defaultDispatcher.dispatch<ViewRoomPayload>({
                action: Action.ViewRoom,
                room_id: result.roomId,
                metricsTrigger: undefined,
            });
            this.props.onFinished();
        } catch {
            if (!this.controller.signal.aborted)
                this.snapshot.merge({ busy: false, error: _t("clawdia_agent|retry_error") });
        }
    };
}
