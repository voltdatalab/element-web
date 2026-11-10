/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";
import { MockViewModel } from "../../core/viewmodel/MockViewModel";
import { CreateAgentView, type CreateAgentSnapshot } from "./CreateAgentView";

function model(snapshot: Partial<CreateAgentSnapshot> = {}) {
    return Object.assign(
        new MockViewModel<CreateAgentSnapshot>({
            name: "Analista",
            description: "",
            busy: false,
            error: "",
            submitted: false,
            ...snapshot,
        }),
        {
            setName: vi.fn(),
            setDescription: vi.fn(),
            submit: vi.fn().mockResolvedValue(undefined),
            cancel: vi.fn(),
        },
    );
}

describe("CreateAgentView", () => {
    it("submits the form and allows cancellation", async () => {
        const vm = model();
        render(<CreateAgentView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
        expect(vm.submit).toHaveBeenCalledOnce();
        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(vm.cancel).toHaveBeenCalledOnce();
    });

    it("shows preparation and locks an admitted request payload", () => {
        render(<CreateAgentView vm={model({ busy: true, submitted: true })} />);
        expect(screen.getByRole("status")).toHaveTextContent("Preparing your agent…");
        expect(screen.getByRole("button", { name: "Create agent" })).toBeDisabled();
        expect(screen.getByLabelText("Name")).toBeDisabled();
    });

    it("shows a recoverable error and keeps the retry enabled", () => {
        render(<CreateAgentView vm={model({ submitted: true, error: "Please retry" })} />);
        expect(screen.getByRole("alert")).toHaveTextContent("Please retry");
        expect(screen.getByRole("button", { name: "Create agent" })).toBeEnabled();
        expect(screen.getByLabelText("Name")).toBeDisabled();
    });
});
