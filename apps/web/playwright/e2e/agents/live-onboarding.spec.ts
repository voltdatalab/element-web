/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { test, expect } from "@playwright/test";
import { populateLocalStorageWithCredentials } from "@element-hq/element-web-playwright-common";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

test("creates a real Pi agent and opens its encrypted DM in the lab (faux model)", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const credentialPath = process.env.CLAWDIA_MATRIX_TEST_CREDENTIALS;
    test.skip(!credentialPath, "Requires the dedicated Matrix/Pi laboratory with a faux model.");
    const credentials = JSON.parse(await readFile(credentialPath!, "utf8")) as { user_id: string; password: string };
    const homeserver = process.env.CLAWDIA_MATRIX_TEST_URL ?? "http://127.0.0.1:18008";
    const response = await fetch(`${homeserver}/_matrix/client/v3/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            type: "m.login.password",
            identifier: { type: "m.id.user", user: credentials.user_id },
            password: credentials.password,
            device_id: randomUUID(),
        }),
    });
    expect(response.ok).toBe(true);
    const login = (await response.json()) as { user_id: string; access_token: string; device_id: string };
    await populateLocalStorageWithCredentials(page, {
        userId: login.user_id,
        accessToken: login.access_token,
        deviceId: login.device_id,
        homeServer: login.user_id.split(":").slice(1).join(":"),
        username: login.user_id.slice(1).split(":")[0],
        homeserverBaseUrl: homeserver,
        password: credentials.password,
    });
    await page.goto("/");
    await expect(page.locator(".mx_MatrixChat")).toBeVisible({ timeout: 45_000 });
    await page.getByRole("navigation", { name: "Room list" }).getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "Create agent" }).click();
    const dialog = page.getByRole("dialog", { name: "Create agent" });
    await dialog.getByLabel("Name", { exact: true }).fill("Analista Pi de validação");
    await dialog.getByLabel("Description (optional)").fill("Agente de validação do onboarding nativo");
    await dialog.getByRole("button", { name: "Create agent" }).click();
    await expect(dialog).not.toBeVisible({ timeout: 60000 });
    await expect(page).toHaveURL(/#\/room\//);
    const composer = page.getByRole("textbox", { name: /message|send a message/i });
    await composer.fill("Olá, Pi");
    await composer.press("Enter");
    await expect(page.getByText("Pi respondeu pela DM criptografada.", { exact: true })).toBeVisible({
        timeout: 45000,
    });
    const screenshot = testInfo.outputPath("agent-dm.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("Encrypted DM with Pi and faux model", { path: screenshot, contentType: "image/png" });
});
