/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Preset } from "matrix-js-sdk/src/matrix";
import { createNewInstance } from "@element-hq/element-web-playwright-common";
import { test, expect } from "../../element-web-test";
import { ElementAppPage } from "../../pages/ElementAppPage";
interface BrowserAgent {
    id: string;
    name: string;
    connect(token: string, dm: string): Promise<void>;
    grantState(room: string): string | undefined;
    pending(room: string): number;
    roomConversations(): number;
    hasRoomMachine(): boolean;
    joinedRooms(): Promise<string[]>;
    diagnostics(): Record<string, unknown>;
    close(): Promise<void>;
}

test("two people share a text-only agent through its private DM and revoke the room", async ({
    page,
    app,
    homeserver,
    user,
    browser,
}, testInfo) => {
    test.setTimeout(120_000);
    const folder = await mkdtemp(path.join(tmpdir(), "clawdia-shared-browser-"));
    // Native service modules have their own Node tsconfig; use their small fixture API at runtime.
    const fixture = (await import(
        new URL("../../../../agents/src/fixtures/shared-browser-agent.ts", import.meta.url).href
    )) as {
        prepareSharedBrowserAgent(folder: string, owner: string, homeserver: string, serverName: string): BrowserAgent;
    };
    const agent = fixture.prepareSharedBrowserAgent(folder, user.userId, homeserver.baseUrl, user.homeServer);
    let peerApp: ElementAppPage | undefined;
    try {
        const bot = await homeserver.registerUser(
            `clawdia_${agent.id.replaceAll("-", "")}`,
            "test-only-password",
            agent.name,
        );
        const peer = await homeserver.registerUser("clawdia_peer", "test-only-password", "Colega");
        const dm = await app.client.createRoom({
            name: agent.name,
            is_direct: true,
            preset: "private_chat" as Preset,
            invite: [bot.userId],
            initial_state: [
                { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
            ],
        });
        await homeserver.csApi.request("POST", `/v3/join/${encodeURIComponent(dm)}`, bot.accessToken, {});
        await agent.connect(bot.accessToken, dm);
        peerApp = new ElementAppPage(await createNewInstance(browser, peer));
        const shared = await app.client.createRoom({
            name: "Equipe autorizada",
            preset: "private_chat" as Preset,
            invite: [peer.userId, bot.userId],
            initial_state: [
                { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
            ],
        });
        await homeserver.csApi.request("POST", `/v3/join/${encodeURIComponent(shared)}`, peer.accessToken, {});
        await app.viewRoomById(dm);
        const composer = page.getByRole("textbox", { name: /message|send a message/i });
        await composer.fill("PRIVATE_SENTINEL");
        await composer.press("Enter");
        await expect(page.getByText("Resposta de teste.", { exact: true })).toBeVisible({ timeout: 45_000 });
        await composer.fill(`!clawdia compartilhar https://matrix.to/#/${encodeURIComponent(shared)}`);
        await composer.press("Enter");
        await expect(page.getByText(/^Agente compartilhado com a sala/)).toBeVisible({ timeout: 45_000 });
        await app.viewRoomById(shared);
        await peerApp.viewRoomById(shared);
        await app.client.sendMessage(shared, {
            "msgtype": "m.text",
            "body": "Pergunta do dono",
            "m.mentions": { user_ids: [bot.userId] },
        });
        await peerApp.client.sendMessage(shared, {
            "msgtype": "m.text",
            "body": "Pergunta da colega",
            "m.mentions": { user_ids: [bot.userId] },
        });
        await expect(page.getByText("Resposta de teste.", { exact: true })).toHaveCount(2, { timeout: 45_000 });
        await expect(peerApp.page.getByText("Resposta de teste.", { exact: true })).toHaveCount(2, { timeout: 45_000 });
        await expect(page.getByText("PRIVATE_SENTINEL", { exact: true })).toHaveCount(0);
        const screenshot = testInfo.outputPath("shared-agent-room.png");
        await page.screenshot({ path: screenshot });
        await testInfo.attach("Authorized room with two people", { path: screenshot, contentType: "image/png" });
        expect(agent.roomConversations()).toBe(1);
        expect(agent.hasRoomMachine()).toBe(false);
        const denied = await app.client.createRoom({
            name: "Sala não autorizada",
            preset: "private_chat" as Preset,
            invite: [bot.userId],
        });
        await app.client.sendMessage(denied, {
            "msgtype": "m.text",
            "body": "Não executar",
            "m.mentions": { user_ids: [bot.userId] },
        });
        await app.viewRoomById(dm);
        await composer.fill(`!clawdia revogar https://matrix.to/#/${encodeURIComponent(shared)}`);
        await composer.press("Enter");
        await expect(page.getByText(/^Acesso revogado à sala/)).toBeVisible({ timeout: 30_000 });
        expect(agent.grantState(shared)).toBe("revoked");
        expect(agent.grantState(denied)).toBeUndefined();
        expect(await agent.joinedRooms()).not.toContain(denied);
        await peerApp.client.sendMessage(shared, {
            "msgtype": "m.text",
            "body": "Negada após revogação",
            "m.mentions": { user_ids: [bot.userId] },
        });
        expect(agent.pending(shared)).toBe(0);
    } finally {
        await testInfo.attach("Shared agent state", {
            body: JSON.stringify(agent.diagnostics()),
            contentType: "application/json",
        });
        await agent.close();
        await peerApp?.page.context().close();
        await rm(folder, { recursive: true, force: true });
    }
});
