/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { test, expect } from "../../element-web-test";

test.use({ config: { clawdia_agents: true } });

test("creates an agent through the compose menu and opens its DM", async ({ page, app, homeserver, user }) => {
    const agent = await homeserver.registerUser("clawdia_agent", "test-only-password", "Analista");
    const roomId = await app.client.createRoom({
        name: "Analista",
        invite: [agent.userId],
        is_direct: true,
        initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
    });
    let requests = 0;
    await page.route("**/clawdia/agents", async (route) => {
        requests += 1;
        expect(route.request().postDataJSON()).toEqual({ name: "Analista", description: "Pesquisa empresas" });
        expect(route.request().headers()["authorization"]).toBe(`Bearer ${user.accessToken}`);
        await route.fulfill({ json: { id: "test-agent", status: "ready", roomId, userId: agent.userId } });
    });
    await page.getByRole("navigation", { name: "Room list" }).getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "Create agent" }).click();
    const dialog = page.getByRole("dialog", { name: "Create agent" });
    await dialog.getByLabel("Name", { exact: true }).fill("Analista");
    await dialog.getByLabel("Description (optional)").fill("Pesquisa empresas");
    await dialog.getByRole("button", { name: "Create agent" }).click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(async () => decodeURIComponent(await app.getCurrentRoomIdFromUrl())).toBe(roomId);
    expect(requests).toBe(1);
});
