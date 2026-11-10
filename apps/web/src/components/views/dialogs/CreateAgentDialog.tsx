/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { CreateAgentView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";
import BaseDialog from "./BaseDialog";
import { CreateAgentViewModel } from "../../../viewmodels/agents/CreateAgentViewModel";
import { SDKContextClass } from "../../../contexts/SDKContextClass";
import { _t } from "../../../languageHandler";

/** Dialog backed by the trusted agent provisioning service. */
export function CreateAgentDialog({ onFinished }: { onFinished: () => void }): JSX.Element {
    const vm = useCreateAutoDisposedViewModel(
        () =>
            new CreateAgentViewModel({
                matrixClient: SDKContextClass.instance.client!,
                onFinished,
            }),
    );
    return (
        <BaseDialog title={_t("clawdia_agent|create")} onFinished={onFinished} hasCancel>
            <CreateAgentView vm={vm} />
        </BaseDialog>
    );
}
