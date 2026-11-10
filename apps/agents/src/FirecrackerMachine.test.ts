/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { FirecrackerMachine } from "./FirecrackerMachine.ts";

void test("binds the worker request to its agent and checks actual artifact bytes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "clawdia-worker-"));
    const address = path.join(dir, "worker.sock");
    const requests: Record<string, unknown>[] = [];
    let invalid = false;
    const server = createServer((socket) => {
        socket.once("data", (data) => {
            requests.push(JSON.parse(data.toString()) as Record<string, unknown>);
            const content = "Olá, microVM";
            socket.end(
                JSON.stringify({
                    ok: true,
                    result: {
                        path: "report.txt",
                        content,
                        sha256: invalid ? "forged" : createHash("sha256").update(content).digest("hex"),
                    },
                }) + "\n",
            );
        });
    });
    server.listen(address);
    await once(server, "listening");
    try {
        const machine = new FirecrackerMachine(address, "agent-1");
        const result = await machine.file("write", "call-1", "report.txt", "Olá, microVM");
        assert.equal(result.content, "Olá, microVM");
        assert.equal(requests[0].agentId, "agent-1");
        assert.equal(requests[0].requestId, "call-1");
        await machine.request("ensure", "ensure-1", { agentId: "forged", op: "exec" });
        assert.equal(requests[1].agentId, "agent-1");
        assert.equal(requests[1].op, "ensure");
        invalid = true;
        await assert.rejects(machine.file("read", "call-2", "report.txt"), /machine_artifact_invalid/);
    } finally {
        await new Promise<void>((done) => server.close(() => done()));
        rmSync(dir, { recursive: true, force: true });
    }
});

void test("missing worker fails with a safe recoverable error", async () => {
    const machine = new FirecrackerMachine("/nonexistent-clawdia-worker.sock", "agent-1");
    await assert.rejects(machine.ensure(), /machine_operation_failed/);
});
