/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { defineConfig } from "vitest/config";

// Vitest's configuration loader requires a default export.
export default defineConfig({
    test: { include: ["*.test.ts"], environment: "node" },
});
