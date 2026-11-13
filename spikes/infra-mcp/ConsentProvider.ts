/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

/** Browser-bound consent operations, called only by the trusted Matrix bridge. */
export interface ConsentProvider extends OAuthServerProvider {
    assertCurrentAccess(token: string, scope?: string): AuthInfo;
    describeConsent(requestId: string, cookie: string): { clientName: string; scopes: string[]; csrf: string };
    assertConsent(requestId: string, cookie: string, csrf: string): void;
    completeConsent(requestId: string, cookie: string, csrf: string, userId: string): string;
    denyConsent(requestId: string, cookie: string, csrf: string): string;
}
