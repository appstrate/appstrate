// SPDX-License-Identifier: Apache-2.0

import { type TokenErrorKind } from "./token-utils.ts";

/**
 * Error thrown when an OAuth2 token exchange fails.
 *
 * Mirrors the {@link import("./token-refresh.ts").RefreshError} pattern so
 * revocation handling is symmetric across the two paths that call the OAuth2
 * token endpoint. The discrimination matters because:
 *
 * - `"revoked"` (HTTP 400 or 401 + `{ "error": "invalid_grant" }` per RFC 6749
 *   §5.2):
 *   the authorization code is dead. The user must restart the OAuth flow.
 *   Callers SHOULD surface a structured "please reconnect" message rather than
 *   a generic 400.
 *
 * - `"transient"`: anything else (network, 5xx, non-JSON, other 4xx, other
 *   OAuth error codes). The authorization code might still be valid on retry
 *   for some classes of failure; the user should be told to retry the request,
 *   not the entire OAuth flow.
 *
 * - `"client_unavailable"`: the OAuth client the flow was started with no
 *   longer resolves (deleted, out of reach, undecryptable), so no exchange was
 *   attempted. Retrying cannot help until an admin restores or re-registers it.
 *
 * - `"issuer_mismatch"`: the authorization response does not provably come from the
 *   authorization server the request was sent to (RFC 9207 `iss`, or a per-server redirect URI —
 *   RFC 9700 §4.4 mix-up defence), so the code is never exchanged.
 */
type OAuthCallbackErrorKind = TokenErrorKind | "client_unavailable" | "issuer_mismatch";

export class OAuthCallbackError extends Error {
  constructor(
    message: string,
    public readonly kind: OAuthCallbackErrorKind,
    public readonly subjectId: string,
    public readonly status?: number,
    public readonly body?: string,
    public readonly oauthError?: string,
    public readonly oauthErrorDescription?: string,
    /**
     * Standard `ErrorOptions`; pass `{ cause }` when raising this from a
     * `catch` so the underlying network/parse error is not discarded.
     * `preserve-caught-error` cannot see custom classes, so this is on us.
     * Last, because every parameter before it is already positional and
     * public — moving one would break every construction site.
     */
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OAuthCallbackError";
  }
}
