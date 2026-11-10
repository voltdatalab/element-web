/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { test, expect } from "@playwright/test";
import { populateLocalStorageWithCredentials } from "@element-hq/element-web-playwright-common";
import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";

const machineTest = process.env.CLAWDIA_FIRECRACKER_TEST === "1";
const realModel = process.env.CLAWDIA_REAL_MODEL_TEST === "1";

test(`creates a Pi agent and opens its encrypted DM in the lab (${realModel ? "real" : "faux"} model)`, async ({
    page,
}, testInfo) => {
    test.setTimeout(machineTest ? 300_000 : 120_000);
    test.skip(machineTest && !realModel, "The Firecracker DM scenario requires a real model.");
    const credentialPath = process.env.CLAWDIA_MATRIX_TEST_CREDENTIALS;
    test.skip(!credentialPath, "Requires the dedicated Matrix/Pi laboratory.");
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
    await dialog
        .getByLabel("Name", { exact: true })
        .fill(machineTest ? "Agente com microVM" : "Analista Pi de validação");
    await dialog.getByLabel("Description (optional)").fill("Agente de validação do onboarding nativo");
    const provisioned = page.waitForResponse(
        (response) => response.url().endsWith("/clawdia/agents") && response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Create agent" }).click();
    const agent = (await (await provisioned).json()) as { id: string; roomId: string };
    await expect(dialog).not.toBeVisible({ timeout: 60000 });
    await expect(page).toHaveURL(/#\/room\//);
    const composer = page.getByRole("textbox", { name: /message|send a message/i });
    if (machineTest) {
        const filename = `prova-${randomUUID().slice(0, 8)}.txt`;
        const content = `Arquivo persistente ClawdIA ${randomUUID()}\n`;
        const sha256 = createHash("sha256").update(content).digest("hex");
        const download = async (): Promise<string> => {
            const links = page.getByRole("button", { name: new RegExp("^" + filename.replaceAll(".", "\\.")) });
            const event = page.waitForEvent("download");
            await links.last().click();
            const file = await event;
            return readFile((await file.path())!, "utf8");
        };
        await composer.fill(
            `Crie na sua microVM o arquivo ${filename}, usando write_file. O conteúdo exato deve ser esta string JSON: ${JSON.stringify(content)}. Depois responda apenas arquivo-criado.`,
        );
        await composer.press("Enter");
        await expect(page.getByText("arquivo-criado", { exact: true })).toBeVisible({ timeout: 90_000 });
        await expect(page.getByRole("button", { name: new RegExp("^" + filename.replaceAll(".", "\\.")) })).toHaveCount(
            1,
        );
        expect(await download()).toBe(content);
        const roomUrl = page.url();
        await composer.fill(
            "Reinicie agora sua microVM usando restart_machine. Depois responda apenas maquina-reiniciada e informe o novo bootId.",
        );
        await composer.press("Enter");
        await expect(page.getByText(/^maquina-reiniciada/)).toBeVisible({ timeout: 90_000 });
        await composer.fill(
            `Recupere do disco da microVM o arquivo ${filename} usando read_file. Não o recrie. Responda apenas arquivo-recuperado.`,
        );
        await composer.press("Enter");
        await expect(page.getByText("arquivo-recuperado", { exact: true })).toBeVisible({ timeout: 90_000 });
        await expect(page.getByRole("button", { name: new RegExp("^" + filename.replaceAll(".", "\\.")) })).toHaveCount(
            2,
        );
        expect(await download()).toBe(content);
        expect(page.url()).toBe(roomUrl);
        const screenshot = testInfo.outputPath("firecracker-dm.png");
        await page.screenshot({ path: screenshot });
        await testInfo.attach("Firecracker file after VM restart", { path: screenshot, contentType: "image/png" });
        await testInfo.attach("Firecracker validation", {
            body: JSON.stringify({ agentId: agent.id, roomId: agent.roomId, filename, sha256 }),
            contentType: "application/json",
        });
        return;
    }
    const marker = `validacao-${randomUUID().slice(0, 8)}`;
    const a = 1000 + Math.floor(Math.random() * 8000);
    const b = 1000 + Math.floor(Math.random() * 8000);
    const prompt = realModel
        ? `Calcule ${a} + ${b}. Responda apenas ${marker}= seguido do resultado numérico. Guarde essa soma.`
        : "Olá, Pi";
    await composer.fill(prompt);
    await composer.press("Enter");
    const answer = realModel ? `${marker}=${a + b}` : "Pi respondeu pela DM criptografada.";
    await expect(page.getByText(answer, { exact: true })).toBeVisible({ timeout: 60_000 });
    if (realModel) {
        // A second turn checks that Pi retained the conversation, beyond a single provider request.
        await composer.fill("Some 7 ao resultado que você guardou. Responda apenas com o novo número.");
        await composer.press("Enter");
        await expect(page.getByText(String(a + b + 7), { exact: true })).toBeVisible({ timeout: 60_000 });
        await testInfo.attach("Real model transcript", {
            body: JSON.stringify({ prompt, answer, followUpAnswer: String(a + b + 7), roomUrl: page.url() }),
            contentType: "application/json",
        });
    }
    const screenshot = testInfo.outputPath("agent-dm.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach(`Encrypted DM with Pi and ${realModel ? "real" : "faux"} model`, {
        path: screenshot,
        contentType: "image/png",
    });
});
