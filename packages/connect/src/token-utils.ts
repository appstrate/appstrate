// SPDX-License-Identifier: Apache-2.0

/**
 * Shared token utilities.
 * Used by both oauth.ts (initial token exchange) and token-refresh.ts (refresh flow).
 *
 * OAuthTokenAuthMethod and OAuthTokenContentType live in @appstrate/core/validation
 * as the single source of truth and are imported directly there by callers.
 */

import type { OAuthTokenAuthMethod, OAuthTokenContentType } from "@appstrate/core/validation";

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
 * `HTTP 400` + body `{ "error": "invalid_grant" }`. Any other failure (network,
 * 5xx, non-JSON body, other 4xx, other OAuth error codes) is treated as transient
 * because the credential might still be valid.
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
 * Classify an HTTP error response from an OAuth2 token endpoint.
 *
 * @param status - HTTP status code of the response
 * @param body - Raw response body (text)
 */
export function parseTokenErrorResponse(status: number, body: string): TokenErrorClassification {
  if (status !== 400) {
    return { kind: "transient" };
  }
  try {
    const parsed = JSON.parse(body) as { error?: unknown; error_description?: unknown };
    if (!parsed || typeof parsed !== "object") {
      return { kind: "transient" };
    }
    const error = typeof parsed.error === "string" ? parsed.error : undefined;
    const errorDescription =
      typeof parsed.error_description === "string" ? parsed.error_description : undefined;
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
  const accessToken = tokenData.access_token as string;
  if (!accessToken) {
    throw new Error("No access_token in token response");
  }

  const refreshToken = (tokenData.refresh_token as string | undefined) ?? fallbackRefreshToken;

  let expiresAt: string | null = null;
  if (typeof tokenData.expires_in === "number") {
    expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
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
