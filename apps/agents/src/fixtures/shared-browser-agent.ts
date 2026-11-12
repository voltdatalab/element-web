/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { mock } from "node:test";
import path from "node:path";
import { AgentStore } from "../store.ts";
import { AgentManager } from "../matrix.ts";
import { PiConversation } from "../pi.ts";
import { openSharedTestConversation } from "./shared-model.ts";

interface BrowserAgentFixture {
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

/** Node-only adapter keeps native Matrix/Pi dependencies outside the browser test's DOM type environment. */
export function prepareSharedBrowserAgent(
    folder: string,
    owner: string,
    homeserver: string,
    serverName: string,
): BrowserAgentFixture {
    const store = new AgentStore(path.join(folder, "agents.sqlite"));
    const agent = store.create(owner, "browser-sharing", "Analista compartilhado", "Agente de teste local");
    const pi = mock.method(PiConversation, "open", openSharedTestConversation);
    const socket = process.env.CLAWDIA_FIRECRACKER_SOCKET;
    delete process.env.CLAWDIA_FIRECRACKER_SOCKET;
    let manager: AgentManager | undefined;
    let matrix: Awaited<ReturnType<AgentManager["ensure"]>> | undefined;
    return {
        id: agent.id,
        name: agent.name,
        connect: async (token: string, dm: string) => {
            store.token(agent.id, token);
            store.room(agent.id, dm);
            manager = new AgentManager(
                { homeserver, serverName, adminToken: "unused-test-only", stateDir: folder, model: "faux-1" },
                store,
            );
            matrix = await manager.ensure(store.get(agent.id)!);
        },
        grantState: (room: string) => store.grant(agent.id, room)?.state,
        pending: (room: string) => {
            const grant = store.grant(agent.id, room);
            return grant ? store.roomTurns(grant).length : 0;
        },
        roomConversations: () => pi.mock.calls.filter((call) => call.arguments[0].includes("/rooms/")).length,
        hasRoomMachine: () =>
            pi.mock.calls.some((call) => call.arguments[0].includes("/rooms/") && call.arguments[4] !== undefined),
        joinedRooms: async () => matrix!.getJoinedRooms(),
        diagnostics: () => ({
            status: store.get(agent.id)?.status,
            dmPending: store
                .pending(agent.id)
                .map((message) => ({ event: message.event_id, hasAnswer: message.answer !== null })),
            grants: store.grants(agent.id).map((grant) => ({
                state: grant.state,
                revision: grant.revision,
                hasSyncBoundary: grant.sync_token !== null,
            })),
            conversationCount: pi.mock.callCount(),
        }),
        close: async () => {
            await manager?.close();
            store.close();
            pi.mock.restore();
            if (socket === undefined) delete process.env.CLAWDIA_FIRECRACKER_SOCKET;
            else process.env.CLAWDIA_FIRECRACKER_SOCKET = socket;
        },
    };
}
