/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import assert from "node:assert/strict";

import { MODEL_CONFIG, prepareModelDirectory } from "./localEmbedding.ts";

assert.equal(process.argv.length, 2, "prepareEmbeddingModel accepts no arguments");
await prepareModelDirectory();
console.log(JSON.stringify(MODEL_CONFIG, null, 2));
