/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Button, Form, Text } from "@vector-im/compound-web";
import { type ViewModel, useViewModel } from "../../core/viewmodel";
import { Flex } from "../../core/utils/Flex";
import { useI18n } from "../../core/i18n/i18nContext";

/** Editable state of the agent creation form. */
export interface CreateAgentSnapshot {
    name: string;
    description: string;
    busy: boolean;
    error: string;
    submitted: boolean;
}

/** Actions handled by the application-side provisioning view model. */
export interface CreateAgentActions {
    setName: (name: string) => void;
    setDescription: (description: string) => void;
    submit: () => Promise<void>;
    cancel: () => void;
}

/** View model contract for the agent creation form. */
export type CreateAgentViewModel = ViewModel<CreateAgentSnapshot, CreateAgentActions>;

/** Create a private agent using the installation's configured model. */
export function CreateAgentView({ vm }: { vm: CreateAgentViewModel }): JSX.Element {
    const { translate: _t } = useI18n();
    const { name, description, busy, error, submitted } = useViewModel(vm);
    return (
        <Form.Root
            onSubmit={(event) => {
                event.preventDefault();
                void vm.submit();
            }}
        >
            <Flex direction="column" gap="var(--cpd-space-4x)" align="stretch">
                <Text as="p">{_t("clawdia_agent|private_description")}</Text>
                <Form.Field name="agentName">
                    <Form.Label>{_t("clawdia_agent|name")}</Form.Label>
                    <Form.TextControl
                        value={name}
                        onChange={(event) => vm.setName(event.target.value)}
                        required
                        maxLength={120}
                        disabled={busy || submitted}
                        autoFocus
                    />
                </Form.Field>
                <Form.Field name="agentDescription">
                    <Form.Label>{_t("clawdia_agent|description")}</Form.Label>
                    <Form.TextControl
                        value={description}
                        onChange={(event) => vm.setDescription(event.target.value)}
                        maxLength={2000}
                        disabled={busy || submitted}
                    />
                </Form.Field>
                {busy && (
                    <Text as="p" role="status">
                        {_t("clawdia_agent|preparing")}
                    </Text>
                )}
                {error && (
                    <Text as="p" role="alert">
                        {error}
                    </Text>
                )}
                <Flex gap="var(--cpd-space-3x)" justify="end">
                    <Button kind="tertiary" type="button" onClick={vm.cancel}>
                        {_t("action|cancel")}
                    </Button>
                    <Button type="submit" disabled={busy || !name.trim()}>
                        {_t("clawdia_agent|create")}
                    </Button>
                </Flex>
            </Flex>
        </Form.Root>
    );
}
