/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { QA_MODEL_CONFIG, qaModelDirectory } from "./localQuestionAnswering.ts";
import { prepareModelArtifacts } from "./modelArtifacts.ts";

/** Explicitly prepare the fixed QA model; print the reproducible manifest only after verification succeeds. */
export async function prepareQAModel(): Promise<void> {
    const directory = qaModelDirectory();
    await prepareModelArtifacts(QA_MODEL_CONFIG, directory);
    console.log(JSON.stringify({ ...QA_MODEL_CONFIG, directory }, null, 4));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    if (process.argv.length !== 2) throw new Error("usage: node prepareQAModel.ts (no arguments)");
    await prepareQAModel();
}
