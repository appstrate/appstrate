// SPDX-License-Identifier: Apache-2.0

import { type TokenErrorKind } from "./token-utils.ts";

/**
 * Error thrown when an OAuth2 token exchange fails.
 *
 * Mirrors the {@link import("./token-refresh.ts").RefreshError} pattern so
 * revocation handling is symmetric across the two paths that call the OAuth2
 * token endpoint. The discrimination matters because:
 *
 * - `"revoked"` (HTTP 400 + `{ "error": "invalid_grant" }` per RFC 6749 §5.2):
 *   the authorization code is dead. The user must restart the OAuth flow.
 *   Callers SHOULD surface a structured "please reconnect" message rather than
 *   a generic 400.
 *
 * - `"transient"`: anything else (network, 5xx, non-JSON, other 4xx, other
 *   OAuth error codes). The authorization code might still be valid on retry
 *   for some classes of failure; the user should be told to retry the request,
 *   not the entire OAuth flow.
 */
export class OAuthCallbackError extends Error {
  constructor(
    message: string,
    public readonly kind: TokenErrorKind,
    public readonly providerId: string,
    public readonly status?: number,
    public readonly body?: string,
    public readonly oauthError?: string,
    public readonly oauthErrorDescription?: string,
  ) {
    super(message);
    this.name = "OAuthCallbackError";
  }
}
