// SPDX-License-Identifier: Apache-2.0

import type { OAuthTokenAuthMethod } from "@appstrate/core/validation";
import {
  parseTokenResponse,
  parseTokenErrorResponse,
  buildTokenHeaders,
  buildTokenBody,
  type OAuthTokenContentType,
  type ParsedTokenResponse,
} from "./token-utils.ts";
import { getErrorMessage } from "@appstrate/core/errors";

export interface RefreshContext {
  /**
   * Token endpoint (`auths.{key}.token_endpoint`). AFPS DROPS the 1.x
   * `refresh_url`: a refresh now POSTs `grant_type=refresh_token` to the same
   * `token_endpoint` used for the authorization-code exchange (RFC 6749 §6).
   */
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  /** Token endpoint client-auth method (`token_endpoint_auth_method`). */
  tokenEndpointAuthMethod?: OAuthTokenAuthMethod;
  scopeSeparator?: string;
  tokenContentType?: OAuthTokenContentType;
}

/**
 * Error thrown by performRefreshTokenExchange when the OAuth token refresh call fails.
 *
 * `kind` discriminates between two cases that callers MUST treat differently:
 *
 * - `"revoked"`: the OAuth server responded with `HTTP 400` + body
 *   `{ "error": "invalid_grant" }` per RFC 6749 §5.2. This is the only
 *   reliable signal that the refresh token is dead and the user must
 *   reconnect. Callers should set `needsReconnection = true`.
 *
 * - `"transient"`: every other failure mode (network error, timeout, 5xx,
 *   non-JSON body, other 4xx, other OAuth error codes). The credential
 *   might still be valid — callers MUST NOT flag the connection, and should
 *   just fail the current request. Flagging on transient errors produces
 *   false positives that force users to reconnect unnecessarily, especially
 *   when the initial 401 that triggered the refresh came from a malformed
 *   agent request (wrong header name, wrong auth scheme, wrong endpoint).
 */
export class RefreshError extends Error {
  constructor(
    message: string,
    public readonly kind: "revoked" | "transient",
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "RefreshError";
  }
}

/** Success payload from {@link performRefreshTokenExchange}. */
export interface RefreshExchangeResult {
  /** Normalised token response (access/refresh token, expiry, scopes). */
  parsed: ParsedTokenResponse;
  /** Raw JSON body — callers that need provider-specific fields (e.g. the
   *  authoritative `scope` echo for shrink detection) read it directly. */
  raw: Record<string, unknown>;
}

/**
 * Perform the OAuth2 `grant_type=refresh_token` HTTP exchange for the
 * integration (`integration_connections`) refresh path: build the request,
 * POST it, classify failures into {@link RefreshError} (`revoked` vs
 * `transient`), and parse the success body. Table-specific concerns — which
 * row to write back, scope-shrink detection, `needsReconnection` flips —
 * stay in the caller so the wire mechanics stay isolated and reusable.
 */
export async function performRefreshTokenExchange(
  ctx: RefreshContext,
  refreshToken: string,
  opts: { label: string; accessTokenFallback?: string },
): Promise<RefreshExchangeResult> {
  // AFPS default for `token_endpoint_auth_method` is
  // `client_secret_basic` (RFC 8414 §2 / RFC 7591 §2). When the manifest
  // omits the field, fall through to Basic auth instead of body auth so the
  // refresh wire matches the wider OAuth 2.1 ecosystem (Anthropic, Google,
  // GitHub, Slack all accept Basic; some IdPs require it).
  //
  // Per-method body shape (RFC 6749 §6 + RFC 7591 §2):
  //   - client_secret_basic: only grant_type + refresh_token in body; client
  //     credentials travel in the Authorization: Basic header.
  //   - client_secret_post:  client_id + client_secret in body, no Basic header.
  //   - none (public client): client_id in body, NO client_secret, NO Basic
  //     header. RFC 6749 §6 + §3.2.1: a public client MUST authenticate
  //     itself by including its client_id in the request.
  const tokenAuthMethod = ctx.tokenEndpointAuthMethod ?? "client_secret_basic";
  const bodyParams: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  };
  if (tokenAuthMethod === "client_secret_post") {
    bodyParams.client_id = ctx.clientId;
    bodyParams.client_secret = ctx.clientSecret;
  } else if (tokenAuthMethod === "none") {
    // Public client: client_id in body only, no secret, no Basic header.
    bodyParams.client_id = ctx.clientId;
  }
  // tokenAuthMethod === "client_secret_basic" → headers carry credentials,
  // body stays minimal (grant_type + refresh_token).
  const body = buildTokenBody(bodyParams, ctx.tokenContentType);

  let response: Response;
  try {
    response = await fetch(ctx.tokenEndpoint, {
      method: "POST",
      headers: buildTokenHeaders(
        tokenAuthMethod,
        ctx.clientId,
        ctx.clientSecret,
        ctx.tokenContentType,
      ),
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new RefreshError(`${opts.label} network error: ${getErrorMessage(err)}`, "transient");
  }

  if (!response.ok) {
    const text = await response.text();
    const classification = parseTokenErrorResponse(response.status, text);
    // Mirror OAuthCallbackError: the raw IdP body lives on the typed
    // `body` field, the message carries only the classification summary
    // so a generic catcher logging `err.message` cannot leak whatever
    // the IdP echoed back (some servers reflect the rejected token).
    const summary =
      classification.error !== undefined
        ? `${classification.error}${classification.errorDescription ? ` — ${classification.errorDescription}` : ""}`
        : `HTTP ${response.status}`;
    throw new RefreshError(
      `${opts.label} failed: ${summary}`,
      classification.kind,
      response.status,
      text,
    );
  }

  let raw: Record<string, unknown>;
  try {
    raw = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new RefreshError(`${opts.label} returned non-JSON response`, "transient");
  }

  const parsed = parseTokenResponse(
    { ...raw, access_token: raw.access_token ?? opts.accessTokenFallback },
    undefined,
    refreshToken,
  );
  return { parsed, raw };
}
