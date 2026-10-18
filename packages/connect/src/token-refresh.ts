// SPDX-License-Identifier: Apache-2.0

import type { OAuthTokenAuthMethod } from "@appstrate/core/validation";
import {
  parseTokenResponse,
  readTokenResponse,
  buildTokenHeaders,
  buildTokenBody,
  assertClientAuthCoherent,
  type ParsedTokenResponse,
  type TokenErrorKind,
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
   * RFC 8707 `resource` the token was requested for. A refresh is a token request, so it binds
   * the new token to the same resource (AFPS §8.6, RFC 8707 §2.2).
   */
  resource?: string;
  /**
   * Injectable egress fetch. Defaults to the SSRF-guarded `oauthEgressFetch`.
   * Tests inject a stub here rather than patching the global `fetch` — the
   * guarded default resolves DNS, which would (correctly) fail-close on
   * non-resolvable test hostnames.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Error thrown by {@link performTokenRequest} when the token endpoint call fails.
 *
 * `kind` discriminates between three cases that callers MUST treat differently:
 *
 * - `"revoked"`: the OAuth server answered `{ "error": "invalid_grant" }`
 *   (RFC 6749 §5.2) on `HTTP 400`, `HTTP 401` (mandated by §5.2 when client
 *   credentials travelled in the `Authorization` header), or a 2xx with no
 *   `access_token`. This is the only reliable signal that the refresh token is
 *   dead and the user must reconnect. Callers should set
 *   `needsReconnection = true`.
 *
 * - `"transient"`: every other failure mode (network error, timeout, 5xx,
 *   non-JSON body, other 4xx, other OAuth error codes, a 2xx with neither
 *   `access_token` nor `error`). The credential
 *   might still be valid — callers MUST NOT flag the connection, and should
 *   just fail the current request. Flagging on transient errors produces
 *   false positives that force users to reconnect unnecessarily, especially
 *   when the initial 401 that triggered the refresh came from a malformed
 *   agent request (wrong header name, wrong auth scheme, wrong endpoint).
 *
 * - `"client_rejected"`: the server rejected the client itself (`invalid_client`
 *   or `unauthorized_client`). The grant may be intact: callers MUST NOT flag
 *   the connection nor count it as a transient failure.
 */
export class RefreshError extends Error {
  constructor(
    message: string,
    public readonly kind: TokenErrorKind,
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

/** Success payload from {@link performTokenRequest}. */
export interface RefreshExchangeResult {
  /** Normalised token response (access/refresh token, expiry, scopes). */
  parsed: ParsedTokenResponse;
  /** Raw JSON body, for provider-specific fields (e.g. `id_token`). */
  raw: Record<string, unknown>;
}

/**
 * Parameters the platform owns in a token request: client authentication
 * (RFC 6749 §2.3, RFC 7523 §2.2) and the RFC 8707 `resource`. A grant never carries them.
 */
const PLATFORM_OWNED_PARAMS = [
  "client_id",
  "client_secret",
  "client_assertion",
  "client_assertion_type",
  "resource",
] as const;

/**
 * Perform an OAuth2 token request (RFC 6749 §3.2) carrying `grant`: add the
 * `resource` and the client authentication, POST it, classify failures into
 * {@link RefreshError} (`revoked` / `client_rejected` / `transient`), and parse
 * the success body. `keepRefreshToken` is the token kept when the response omits
 * one. Table-specific concerns — which row to write back, `needsReconnection`
 * flips — stay in the caller so the wire mechanics stay isolated and reusable.
 */
export async function performTokenRequest(
  ctx: RefreshContext,
  grant: Readonly<Record<string, string>>,
  opts: { label: string; keepRefreshToken?: string },
): Promise<RefreshExchangeResult> {
  // A malformed grant is a configuration fault, never a `RefreshError`: nothing is sent.
  if (!grant.grant_type) throw new Error(`${opts.label}: the grant carries no grant_type`);
  const owned = PLATFORM_OWNED_PARAMS.filter((name) => Object.hasOwn(grant, name));
  if (owned.length > 0) {
    throw new Error(`${opts.label}: the grant carries platform-owned ${owned.join(", ")}`);
  }
  // AFPS default for `token_endpoint_auth_method` is
  // `client_secret_basic` (RFC 8414 §2 / RFC 7591 §2). When the manifest
  // omits the field, fall through to Basic auth instead of body auth so the
  // wire matches the wider OAuth 2.1 ecosystem (Anthropic, Google,
  // GitHub, Slack all accept Basic; some IdPs require it).
  //
  // Per-method body shape (RFC 6749 §2.3 + RFC 7591 §2):
  //   - client_secret_basic: only the grant in body; client
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
    ...grant,
    ...(ctx.resource ? { resource: ctx.resource } : {}),
  };
  if (tokenAuthMethod === "client_secret_post") {
    bodyParams.client_id = ctx.clientId;
    bodyParams.client_secret = ctx.clientSecret;
  } else if (tokenAuthMethod === "none") {
    // Public client: client_id in body only, no secret, no Basic header.
    bodyParams.client_id = ctx.clientId;
  }
  // tokenAuthMethod === "client_secret_basic" → headers carry credentials,
  // body stays the grant.
  const body = buildTokenBody(bodyParams);

  let response: Response;
  try {
    // SSRF-guarded: this POST carries the grant + client_secret. A blocked
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
    // The cause tells a request never sent (`SsrfBlockedError`) from one that may have arrived.
    throw new RefreshError(
      `${opts.label} network error: ${getErrorMessage(err)}`,
      "transient",
      undefined,
      undefined,
      { cause: err },
    );
  }

  // A 2xx without `access_token` is a FAILED request, never a success with the
  // caller's current token substituted: on a refresh that would persist the very
  // token it exists to replace and reset `needsReconnection` / the failure
  // streak on a dead credential.
  const read = await readTokenResponse(response);
  if (!read.ok) {
    throw new RefreshError(
      `${opts.label} failed: ${read.summary}`,
      read.kind,
      read.status,
      read.body,
      read.cause === undefined ? undefined : { cause: read.cause },
    );
  }

  // `keepRefreshToken` is a DIFFERENT case: RFC 6749 §6 lets the server omit
  // `refresh_token` to mean "keep the one you have", so non-rotating providers
  // (Google, Slack, GitHub) depend on it.
  const parsed = parseTokenResponse(read.raw, opts.keepRefreshToken);
  return { parsed, raw: read.raw };
}

/**
 * The `grant_type=refresh_token` exchange (RFC 6749 §6) of the integration
 * (`integration_connections`) refresh path; keeps `refreshToken` when the
 * server does not rotate it.
 */
export function performRefreshTokenExchange(
  ctx: RefreshContext,
  refreshToken: string,
  opts: { label: string },
): Promise<RefreshExchangeResult> {
  return performTokenRequest(
    ctx,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    { label: opts.label, keepRefreshToken: refreshToken },
  );
}
