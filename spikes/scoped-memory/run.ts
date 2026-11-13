/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import assert from "node:assert/strict";
import { MemoryLab } from "./MemoryLab.ts";
import { accessCases, seedSynthetic, syntheticNotes } from "./fixtures.ts";

// No configurable database, credentials or network endpoints: always a new in-memory fixture.
assert.equal(process.argv.length, 2, "This demo accepts no arguments or database paths");
const lab = new MemoryLab(":memory:");
const checks: string[] = [];
try {
    seedSynthetic(lab);
    for (const { conversation, agent, requester, scopes } of accessCases) {
        if (!scopes) {
            assert.throws(() => lab.beginTurn(conversation, agent, requester), /access_denied/);
            continue;
        }
        const result = lab.search(lab.beginTurn(conversation, agent, requester), "synthetic");
        assert.deepEqual(
            result.notes.map((note) => note.id).sort(),
            syntheticNotes
                .filter((note) => scopes.includes(note.scopeId))
                .map((note) => note.id)
                .sort(),
        );
    }
    checks.push("access_matrix");

    const turn = lab.beginTurn("room", "a", "owner");
    const example = lab.search(turn, "FIXTURE_PROJECT_1");
    assert.equal(example.notes.length, 1);
    assert.equal(lab.search(turn, "FIXTURE_DM-A").notes.length, 0);
    assert.equal(lab.search(turn, "FIXTURE_DM-B").notes.length, 0);
    assert.equal(lab.search(turn, "FIXTURE_RESTRICTED").notes.length, 0);
    checks.push("private_partitions_excluded");

    lab.setScope({ id: "project", kind: "shared", readers: ["owner"], agents: ["a"] });
    const output: string[] = [];
    assert.throws(() => lab.dispatch(turn, example, (text) => output.push(text)), /access_revoked/);
    assert.equal(output.length, 0);
    checks.push("revocation_before_handoff");

    lab.setScope({ id: "project", kind: "shared", readers: ["owner", "peer", "director"], agents: ["a", "b"] });
    const fresh = lab.beginTurn("room", "a", "owner");
    assert.throws(() => lab.search(turn, "synthetic"), /access_revoked/);
    checks.push("old_turn_not_revived");

    lab.createDigest("extractive-view", "project", ["project-1"]);
    const previous = lab.search(fresh, "FIXTURE_PROJECT_1");
    lab.addNote({
        id: "corrected",
        scopeId: "project",
        text: "synthetic project correction",
        sourceId: "fixture:project:1",
        sourceVersion: 2,
        supersedes: "project-1",
    });
    assert.equal(lab.search(fresh, "FIXTURE_PROJECT_1").notes.length, 0);
    assert.throws(() => lab.dispatch(fresh, previous, () => {}), /stale_source/);
    assert.deepEqual(
        lab.search(fresh, "project correction").notes.map((note) => note.sourceVersion),
        [2],
    );
    checks.push("source_correction");

    console.log(
        JSON.stringify(
            {
                status: "PASS_OFFLINE_SYNTHETIC",
                seededNotes: syntheticNotes.length,
                compartments: [...new Set(syntheticNotes.map((note) => note.scopeId))],
                accessCases: accessCases.length,
                checks,
                exampleAuthorizedSource: example.notes[0],
                limits: [
                    "No LLM or semantic compression",
                    "No production integration",
                    "Trusted fixture control plane",
                    "Synchronous handoff, not distributed delivery",
                    "Not a security certification",
                ],
            },
            null,
            2,
        ),
    );
} finally {
    lab.close();
}
