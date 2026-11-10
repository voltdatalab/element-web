/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMockedViewModel } from "../../core/viewmodel";
import { CreateAgentView, type CreateAgentSnapshot } from "./CreateAgentView";

function FormStory(snapshot: CreateAgentSnapshot): JSX.Element {
    const vm = useMockedViewModel(snapshot, { setName: fn(), setDescription: fn(), submit: fn(), cancel: fn() });
    return <CreateAgentView vm={vm} />;
}

const meta = {
    title: "Agents/Create agent",
    component: FormStory,
    args: { name: "", description: "", busy: false, error: "", submitted: false },
} satisfies Meta<typeof FormStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Preparing: Story = { args: { name: "Analista", busy: true, submitted: true } };
export const Retry: Story = {
    args: { name: "Analista", submitted: true, error: "We could not open the conversation. Try again." },
};
