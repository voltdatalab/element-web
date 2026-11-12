/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { MatrixClient } from "matrix-bot-sdk";
import type { SharingSync } from "./roomSharingTypes.ts";

/** Commit admissions and initial-room boundaries before persisting the SDK sync cursor. */
export class AgentMatrixClient extends MatrixClient {
    protected override persistTokenAfterSync = true;
    public beforeSync?: (batch: SharingSync) => void;
    public afterSync?: (batch: SharingSync) => void;

    protected override async processSync(
        batch: SharingSync,
        emit?: (event: string, ...payload: unknown[]) => Promise<unknown>,
    ): Promise<void> {
        try {
            this.beforeSync?.(batch);
            await super.processSync(batch, emit);
            this.afterSync?.(batch);
        } catch (error) {
            // The SDK advances its in-memory cursor before processing. Stop rather than skip failed admissions.
            this.stop();
            throw error;
        }
    }
}
