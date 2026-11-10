/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { composeStories } from "@storybook/react-vite";
import { render, screen } from "@test-utils";
import { describe, it, expect, vi } from "vitest";
import React from "react";

import userEvent from "@testing-library/user-event";
import { RoomListHeaderView } from "./RoomListHeaderView";
import { MockedViewModel, defaultSnapshot } from "./test-utils";

import * as stories from "./RoomListHeaderView.stories";

const { Default, NoSpaceMenu, CollapseSections, ExpandSections } = composeStories(stories);

describe("RoomListHeaderView", () => {
    it("keeps the compose menu available for agents when chat is otherwise the only action", async () => {
        const createAgent = vi.fn();
        const vm = Object.assign(
            new MockedViewModel({
                ...defaultSnapshot,
                canCreateAgent: true,
                canCreateRoom: false,
                canCreateVideoRoom: false,
                areSectionsEnabled: false,
            }),
            { createAgent },
        );
        render(<RoomListHeaderView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "New" }));
        await userEvent.click(screen.getByRole("menuitem", { name: "Create agent" }));
        expect(createAgent).toHaveBeenCalledOnce();
    });

    it("renders the default state", () => {
        const { container } = render(<Default />);
        expect(container).toMatchSnapshot();
    });

    it("renders without space menu", () => {
        const { container } = render(<NoSpaceMenu />);
        expect(container).toMatchSnapshot();
    });

    it("renders collapse button", () => {
        const { container } = render(<CollapseSections />);
        expect(container).toMatchSnapshot();
    });

    it("renders expand button", () => {
        const { container } = render(<ExpandSections />);
        expect(container).toMatchSnapshot();
    });

    it("should bind the collapse all sections action", () => {
        const { getByRole } = render(<CollapseSections />);
        const collapseButton = getByRole("button", { name: "Collapse all sections" });
        collapseButton.click();
        expect(CollapseSections.args?.collapseOrExpandSections).toHaveBeenCalled();
    });
});
