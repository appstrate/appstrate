// SPDX-License-Identifier: Apache-2.0

/**
 * Shared token utilities.
 * Used by both oauth.ts (initial token exchange) and token-refresh.ts (refresh flow).
 *
 * `OAuthTokenAuthMethod` (= AFPS `token_endpoint_auth_method`) is the single
 * source of truth in @appstrate/core/validation. The token-request body
 * content-type is a wire-level concern with no manifest field in AFPS, so it
 * is owned here as {@link OAuthTokenContentType}.
 */

import type { OAuthTokenAuthMethod } from "@appstrate/core/validation";

/**
 * Content type of the OAuth2 token-endpoint request body.
 *
 * Standard OAuth2 (RFC 6749 §4.1.3) is `application/x-www-form-urlencoded`;
 * a few providers (Atlassian/Jira) require `application/json`. Owned by the
 * connect package — AFPS has no manifest field for this; the platform
 * layer passes it through from per-provider config when needed.
 */
export type OAuthTokenContentType = "application/x-www-form-urlencoded" | "application/json";

/**
 * Build headers for an OAuth2 token endpoint request.
 * When tokenAuthMethod is "client_secret_basic", credentials are sent
 * as an Authorization: Basic header (RFC 6749 §2.3.1) instead of POST body.
 * When tokenContentType is "application/json", the Content-Type is set to JSON
 * (required by providers like Atlassian/Jira that don't accept form-urlencoded).
 */
export function buildTokenHeaders(
  tokenAuthMethod: OAuthTokenAuthMethod | undefined,
  clientId: string,
  clientSecret: string,
  tokenContentType?: OAuthTokenContentType,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": tokenContentType ?? "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (tokenAuthMethod === "client_secret_basic") {
    // RFC 6749 §2.3.1: credentials MUST be URL-encoded before base64
    const encoded = Buffer.from(
      `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
    ).toString("base64");
    headers["Authorization"] = `Basic ${encoded}`;
  }
  return headers;
}

/**
 * Build the token request body.
 * When tokenContentType is "application/json", returns a JSON string.
 * Otherwise returns a URLSearchParams string (standard form-urlencoded).
 */
export function buildTokenBody(
  params: Record<string, string>,
  tokenContentType?: OAuthTokenContentType,
): string {
  if (tokenContentType === "application/json") {
    return JSON.stringify(params);
  }
  return new URLSearchParams(params).toString();
}

export interface ParsedTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string | null;
  scopesGranted: string[];
  /** Requested scopes that the provider did not grant (RFC 6749 §3.3 narrowing). */
  scopeShortfall: string[];
  /** Scopes granted that were never requested (provider over-grant). */
  scopeCreep: string[];
}

/**
 * Classified outcome of a non-2xx OAuth2 token endpoint response.
 *
 * Per RFC 6749 §5.2, a dead authorization code or refresh token is signaled by
 * `{ "error": "invalid_grant" }` on `HTTP 400` — or on `HTTP 401`, which the
 * same section mandates whenever the client authenticated through the
 * `Authorization` header. Any other failure (network, 5xx, non-JSON body, other
 * 4xx, other OAuth error codes) is treated as transient because the credential
 * might still be valid.
 *
 * Both the initial token exchange (oauth.ts) and the refresh flow (token-refresh.ts)
 * MUST classify errors through this helper so that revocation handling stays
 * symmetric — historically only the refresh path detected revocation, leaving the
 * initial callback path to bubble up a generic 400 with no actionable signal.
 */
export type TokenErrorKind = "revoked" | "transient";

export interface TokenErrorClassification {
  kind: TokenErrorKind;
  /** OAuth2 error code from the response body (e.g. "invalid_grant") if parseable. */
  error?: string;
  /** Human-readable description from the response body if present. */
  errorDescription?: string;
}

/**
 * Redact a provider-supplied OAuth2 `error_description` before it can flow
 * into an `Error.message` a logger or UI might surface.
 *
 * RFC 6749 §5.2 `error_description` is free text, but several IdPs echo the
 * rejected authorization code / refresh token back inside it — and both the
 * initial-exchange and refresh paths concatenate this field into the thrown
 * error's `message`. This strips long unbroken credential-like runs (≥20 chars
 * of the token / JWT / base64url / hex alphabet) to `[redacted]` and caps the
 * overall length. The full untouched body stays available on the typed `body`
 * field of the thrown error for authorized diagnostics — only the
 * human-readable summary carried in the message is sanitized here.
 */
const CREDENTIAL_LIKE_RUN = /[A-Za-z0-9._~+/=-]{20,}/g;
const MAX_ERROR_DESCRIPTION_LEN = 200;

export function redactErrorDescription(description: string): string {
  const stripped = description.replace(CREDENTIAL_LIKE_RUN, "[redacted]");
  return stripped.length > MAX_ERROR_DESCRIPTION_LEN
    ? `${stripped.slice(0, MAX_ERROR_DESCRIPTION_LEN)}…`
    : stripped;
}

/**
 * Classify an HTTP error response from an OAuth2 token endpoint.
 *
 * Both 400 and 401 bodies are parsed. RFC 6749 §5.2 lets an authorization
 * server answer `invalid_client` with EITHER status ("If the client attempted
 * to authenticate via the Authorization request header field, the
 * authorization server MUST respond with an HTTP 401"), and providers split
 * roughly evenly on which they pick. Parsing only 400 dropped the error code
 * of every 401 on the floor, which is exactly the client-authentication
 * failure an operator most needs named: a wrong
 * `token_endpoint_auth_method` in a manifest surfaces as `invalid_client`,
 * and without the code the whole class is indistinguishable from a network
 * blip in the logs.
 *
 * Only `invalid_grant` maps to `"revoked"` — a dead authorization code or
 * refresh token, where retrying is pointless and the stored PKCE state should
 * be dropped. `invalid_client` stays `"transient"`: the grant is untouched, it
 * is the client credentials that are wrong, and an operator fixing the
 * registration makes the same connect attempt work.
 *
 * @param status - HTTP status code of the response
 * @param body - Raw response body (text)
 */
export function parseTokenErrorResponse(status: number, body: string): TokenErrorClassification {
  if (status !== 400 && status !== 401) {
    return { kind: "transient" };
  }
  try {
    const parsed = JSON.parse(body) as { error?: unknown; error_description?: unknown };
    if (!parsed || typeof parsed !== "object") {
      return { kind: "transient" };
    }
    const error = typeof parsed.error === "string" ? parsed.error : undefined;
    // Redact at the source so both consumers (token-exchange.ts,
    // token-refresh.ts) that fold this into `Error.message` get the sanitized
    // value; the raw body remains on the error's typed `body` field.
    const errorDescription =
      typeof parsed.error_description === "string"
        ? redactErrorDescription(parsed.error_description)
        : undefined;
    if (error === "invalid_grant") {
      return { kind: "revoked", error, errorDescription };
    }
    return { kind: "transient", error, errorDescription };
  } catch {
    return { kind: "transient" };
  }
}

/**
 * Parse a standard OAuth2 token endpoint response.
 *
 * Scope parsing is universal: splits by comma, space, or %20 to handle all
 * provider conventions (e.g. GitHub returns comma-separated, Google uses spaces).
 *
 * Scope validation: when `requestedScopes` is provided, the response is compared
 * against it to surface `scopeShortfall` (provider granted fewer scopes than
 * requested — caller should flag the connection as `needsReconnection: true` or
 * present a warning to the user) and `scopeCreep` (provider returned more than
 * requested — typically benign, log only). Some providers (Slack, GitHub legacy)
 * always return all owner scopes regardless of the request, so creep is not a
 * blocking signal.
 *
 * @param tokenData - Raw JSON response from the token endpoint
 * @param requestedScopes - Scopes that were sent in the authorize / refresh call. Used
 *   both as a fallback when the response omits `scope` and as the reference for
 *   shortfall / creep comparison.
 * @param fallbackRefreshToken - Refresh token to preserve if not present in response
 */
export function parseTokenResponse(
  tokenData: Record<string, unknown>,
  requestedScopes?: string[],
  fallbackRefreshToken?: string,
): ParsedTokenResponse {
  if (typeof tokenData.access_token !== "string" || !tokenData.access_token) {
    throw new Error("No (string) access_token in token response");
  }
  const accessToken = tokenData.access_token;

  const refreshToken =
    typeof tokenData.refresh_token === "string" ? tokenData.refresh_token : fallbackRefreshToken;

  // Some IdPs (Azure AD v1, certain Keycloak configs) serialize `expires_in`
  // as a JSON string ("3600"). Coerce so the proactive lead-window refresh
  // still fires — a strict `typeof === "number"` check would drop it and
  // leave `expiresAt: null` (token treated as never-expiring).
  let expiresAt: string | null = null;
  const expiresIn =
    typeof tokenData.expires_in === "number"
      ? tokenData.expires_in
      : typeof tokenData.expires_in === "string"
        ? Number(tokenData.expires_in)
        : NaN;
  if (Number.isFinite(expiresIn)) {
    expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  }

  const scopeStr = typeof tokenData.scope === "string" ? tokenData.scope : "";
  const responseScopes = scopeStr ? scopeStr.split(/[\s,]+|%20/).filter(Boolean) : [];
  const scopesGranted = responseScopes.length > 0 ? responseScopes : (requestedScopes ?? []);

  const requested = requestedScopes ?? [];
  const grantedSet = new Set(scopesGranted);
  const requestedSet = new Set(requested);
  const scopeShortfall = requested.filter((s) => !grantedSet.has(s));
  const scopeCreep = scopesGranted.filter((s) => !requestedSet.has(s));

  return { accessToken, refreshToken, expiresAt, scopesGranted, scopeShortfall, scopeCreep };
}

/**
 * Refuse to build a token request whose client-authentication method and
 * secret disagree.
 *
 * `client_secret_post` / `client_secret_basic` mean the client HAS a password
 * (RFC 6749 §2.3); a client without one authenticates by `client_id` alone,
 * which is `token_endpoint_auth_method: "none"` (RFC 7591 §2). Pairing a
 * secret-based method with an empty secret is therefore not a degraded state
 * to be smoothed over — it is a request that cannot be correct, and sending it
 * anyway is how `client_secret=` (present but empty) reached providers that
 * reject it: Dropbox answered `invalid_client` while Airtable tolerated the
 * equivalent empty Basic header, so one integration silently worked and
 * another hard-failed on the same misconfiguration.
 *
 * Callers resolve the pair together — `resolveIntegrationClientById` and
 * `resolveConnectClient` return the method alongside the credentials it
 * belongs to — so reaching this throw means a caller built the pair itself and
 * got it wrong. Loud beats a silent downgrade: a downgrade would paper over
 * exactly the kind of drift this exists to surface.
 */
export function assertClientAuthCoherent(
  method: OAuthTokenAuthMethod | undefined,
  clientSecret: string | undefined,
  label: string,
): void {
  if (method === undefined || method === "none") return;
  if (clientSecret) return;
  throw new Error(
    `${label}: token_endpoint_auth_method='${method}' requires a client_secret, but none was ` +
      `resolved. A client registered without a secret is a public client and must be resolved ` +
      `as token_endpoint_auth_method='none'.`,
  );
}
