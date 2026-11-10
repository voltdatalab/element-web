/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "matrix-js-sdk/src/matrix";
import { CreateAgentViewModel } from "./CreateAgentViewModel";
import dispatcher from "../../dispatcher/dispatcher";
import { setDMRoom } from "../../Rooms";

vi.mock("../../Rooms", () => ({ setDMRoom: vi.fn() }));
vi.mock("../../dispatcher/dispatcher", () => ({ default: { dispatch: vi.fn() } }));
vi.mock("../../languageHandler", () => ({ _t: (key: string) => key }));

describe("CreateAgentViewModel", () => {
    const joinRoom = vi.fn().mockResolvedValue({});
    const onFinished = vi.fn();
    const matrixClient = {
        getUserId: () => "@owner:example.org",
        getAccessToken: () => "test-only-token",
        joinRoom,
    } as unknown as MatrixClient;
    let vm: CreateAgentViewModel;

    beforeEach(() => {
        sessionStorage.clear();
        vi.clearAllMocks();
        vm = new CreateAgentViewModel({ matrixClient, onFinished });
    });
    afterEach(() => {
        vm.dispose();
        vi.unstubAllGlobals();
    });

    it("uses the authenticated Matrix session and opens the returned DM", async () => {
        const fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ status: "ready", roomId: "!dm:example.org", userId: "@agent:example.org" }),
        });
        vi.stubGlobal("fetch", fetch);
        vm.setName("Analista");
        vm.setDescription("Pesquisa empresas");
        await vm.submit();
        expect(fetch).toHaveBeenCalledWith(
            "/clawdia/agents",
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: "Bearer test-only-token" }),
                body: JSON.stringify({ name: "Analista", description: "Pesquisa empresas" }),
            }),
        );
        expect(joinRoom).toHaveBeenCalledWith("!dm:example.org");
        expect(setDMRoom).toHaveBeenCalledWith(matrixClient, "!dm:example.org", "@agent:example.org");
        expect(dispatcher.dispatch).toHaveBeenCalledWith(expect.objectContaining({ room_id: "!dm:example.org" }));
        expect(onFinished).toHaveBeenCalledOnce();
        expect(sessionStorage.length).toBe(0);
    });

    it("recovers the exact request after a failure and dialog reopening", async () => {
        const fetch = vi.fn().mockResolvedValue({ ok: false });
        vi.stubGlobal("fetch", fetch);
        vm.setName("Analista");
        await vm.submit();
        const first = fetch.mock.calls[0][1];
        expect(vm.getSnapshot()).toMatchObject({ busy: false, submitted: true, error: "clawdia_agent|retry_error" });
        vm.dispose();
        vm = new CreateAgentViewModel({ matrixClient, onFinished });
        expect(vm.getSnapshot().name).toBe("Analista");
        await vm.submit();
        expect(fetch.mock.calls[1][1].headers["Idempotency-Key"]).toBe(first.headers["Idempotency-Key"]);
        expect(fetch.mock.calls[1][1].body).toBe(first.body);
        expect(onFinished).not.toHaveBeenCalled();
    });

    it("ignores a repeated submit while provisioning is in flight", async () => {
        const fetch = vi.fn().mockImplementation(() => new Promise(() => undefined));
        vi.stubGlobal("fetch", fetch);
        vm.setName("Analista");
        void vm.submit();
        await vm.submit();
        expect(fetch).toHaveBeenCalledOnce();
    });

    it("keeps the request recoverable when joining the room fails", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ status: "ready", roomId: "!dm:example.org", userId: "@agent:example.org" }),
            }),
        );
        joinRoom.mockRejectedValueOnce(new Error("offline"));
        vm.setName("Analista");
        await vm.submit();
        expect(sessionStorage.length).toBe(1);
        expect(onFinished).not.toHaveBeenCalled();
        expect(vm.getSnapshot().busy).toBe(false);
    });

    it("keeps the admitted request when the dialog closes during room joining", async () => {
        let finishJoin!: (value: object) => void;
        joinRoom.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishJoin = resolve;
                }),
        );
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValue({
                    ok: true,
                    json: async () => ({ status: "ready", roomId: "!dm:example.org", userId: "@agent:example.org" }),
                }),
        );
        vm.setName("Analista");
        const pending = vm.submit();
        await vi.waitFor(() => expect(joinRoom).toHaveBeenCalledOnce());
        vm.dispose();
        finishJoin({});
        await pending;
        expect(dispatcher.dispatch).not.toHaveBeenCalled();
        expect(sessionStorage.length).toBe(1);
    });

    it("discards malformed saved drafts", () => {
        sessionStorage.setItem("clawdia.agent-draft:@owner:example.org", "null");
        const other = new CreateAgentViewModel({ matrixClient, onFinished });
        expect(other.getSnapshot().name).toBe("");
        expect(other.getSnapshot().submitted).toBe(false);
        other.dispose();
    });
});
