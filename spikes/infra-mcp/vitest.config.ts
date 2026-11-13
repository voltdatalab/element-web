/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: { include: ["**/*.test.ts"], maxWorkers: 1, testTimeout: 20000, hookTimeout: 20000 },
});
