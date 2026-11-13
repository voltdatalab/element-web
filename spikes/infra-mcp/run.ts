/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

if (process.argv.length !== 2) {
    console.error("unexpected_arguments");
    process.exitCode = 1;
} else {
    try {
        const { exercise } = await import("./exercise.ts");
        console.log(JSON.stringify(await exercise(), null, 2));
    } catch {
        console.error("synthetic_mcp_experiment_failed");
        process.exitCode = 1;
    }
}
