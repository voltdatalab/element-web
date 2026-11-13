/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { describe, it, expect } from "vitest";
import { exercise } from "./exercise.ts";

describe("complete synthetic OAuth to MCP path", () => {
    it("uses the local protocol endpoints and a real SDK client without live infrastructure", async () => {
        const report = await exercise();
        expect(report).toMatchObject({
            status: "PASS_LOCAL_SYNTHETIC_MCP",
            authenticatedToolCalls: 1,
            outOfScopeBlocked: true,
            revokedConnectionBlocked: true,
            pkceMismatchBlocked: true,
            matrixSessionStillValid: true,
            productionConnections: 0,
        });
        expect(JSON.stringify(report)).not.toMatch(/access_token|refresh_token|code_verifier|Authorization|cookie/i);
    });
});
