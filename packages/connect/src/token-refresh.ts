// SPDX-License-Identifier: Apache-2.0

import type { OAuthTokenAuthMethod } from "@appstrate/core/validation";
import {
  parseTokenResponse,
  parseTokenErrorResponse,
  buildTokenHeaders,
  buildTokenBody,
  assertClientAuthCoherent,
  type ParsedTokenResponse,
} from "./token-utils.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { oauthEgressFetch } from "./oauth-egress.ts";

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
  /**
   * Injectable egress fetch. Defaults to the SSRF-guarded `oauthEgressFetch`.
   * Tests inject a stub here rather than patching the global `fetch` — the
   * guarded default resolves DNS, which would (correctly) fail-close on
   * non-resolvable test hostnames.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Error thrown by performRefreshTokenExchange when the OAuth token refresh call fails.
 *
 * `kind` discriminates between two cases that callers MUST treat differently:
 *
 * - `"revoked"`: the OAuth server responded with `HTTP 400` or `HTTP 401` +
 *   body `{ "error": "invalid_grant" }` per RFC 6749 §5.2. This is the only
 *   reliable signal that the refresh token is dead and the user must
 *   reconnect. Callers should set `needsReconnection = true`. A 401 carrying
 *   this code reaches here because §5.2 mandates that status whenever client
 *   credentials travelled in the `Authorization` header; while 401 bodies went
 *   unparsed such a response classified as `"transient"`, so a dead token was
 *   retried until the failure-streak threshold escalated it instead.
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
    /**
     * Standard `ErrorOptions`; pass `{ cause }` when raising this from a
     * `catch` so the underlying network/parse error is not discarded.
     * `preserve-caught-error` cannot see custom classes, so this is on us.
     */
    options?: ErrorOptions,
  ) {
    super(message, options);
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
  opts: { label: string },
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
  // Same invariant as the initial exchange: the caller hands us a method and a
  // secret that belong together, or nothing is sent at all.
  assertClientAuthCoherent(tokenAuthMethod, ctx.clientSecret, opts.label);
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
  const body = buildTokenBody(bodyParams);

  let response: Response;
  try {
    // SSRF-guarded: this POST carries refresh_token + client_secret. A blocked
    // host throws SsrfBlockedError (caught below → `transient`; the message
    // carries only the guard's host/reason, never the secret body).
    const doFetch = ctx.fetchImpl ?? oauthEgressFetch;
    response = await doFetch(ctx.tokenEndpoint, {
      method: "POST",
      headers: buildTokenHeaders(tokenAuthMethod, ctx.clientId, ctx.clientSecret),
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
  } catch (err) {
    // Same as the exchange path: `json()` consumed the stream, so the
    // SyntaxError is the only surviving description of what came back.
    throw new RefreshError(
      `${opts.label} returned non-JSON response`,
      "transient",
      response.status,
      undefined,
      { cause: err },
    );
  }

  // No access-token fallback: a 2xx body without `access_token` is a FAILED
  // refresh, and `parseTokenResponse` throws on it. Substituting the caller's
  // current token here recorded the exchange as a success — persisting the very
  // token the refresh existed to replace, and resetting `needsReconnection` /
  // the failure streak with it. Real producers of that body exist (IdPs that
  // answer `200 {"error":"invalid_grant"}`, captive-portal JSON, a bare `{}`),
  // and with no `expires_in` the row also lost its `expires_at`, after which
  // neither the proactive lead window nor the failure escalation could fire
  // again: a dead credential marked healthy, permanently.
  //
  // `refreshToken` as the third argument is a DIFFERENT case and stays: RFC
  // 6749 §6 lets the server omit `refresh_token` to mean "keep the one you
  // have", so non-rotating providers (Google, Slack, GitHub) depend on it.
  const parsed = parseTokenResponse(raw, undefined, refreshToken);
  return { parsed, raw };
}
