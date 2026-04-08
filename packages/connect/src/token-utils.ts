// SPDX-License-Identifier: Apache-2.0

/**
 * Shared token utilities.
 * Used by both oauth.ts (initial token exchange) and token-refresh.ts (refresh flow).
 */

export type OAuthTokenAuthMethod = "client_secret_basic" | "client_secret_post";
export type OAuthTokenContentType =
  | "application/json"
  | "application/x-www-form-urlencoded";

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
}

/**
 * Parse a standard OAuth2 token endpoint response.
 *
 * Scope parsing is universal: splits by comma, space, or %20 to handle all
 * provider conventions (e.g. GitHub returns comma-separated, Google uses spaces).
 *
 * @param tokenData - Raw JSON response from the token endpoint
 * @param fallbackScopes - Scopes to use if none are returned in the response
 * @param fallbackRefreshToken - Refresh token to preserve if not present in response
 */
export function parseTokenResponse(
  tokenData: Record<string, unknown>,
  fallbackScopes?: string[],
  fallbackRefreshToken?: string,
): ParsedTokenResponse {
  const accessToken = tokenData.access_token as string;
  if (!accessToken) {
    throw new Error("No access_token in token response");
  }

  const refreshToken = (tokenData.refresh_token as string | undefined) ?? fallbackRefreshToken;

  // Compute expiration
  let expiresAt: string | null = null;
  if (typeof tokenData.expires_in === "number") {
    expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
  }

  // Extract granted scopes — split by comma, space, or %20 universally
  const scopeStr = typeof tokenData.scope === "string" ? tokenData.scope : "";
  const scopesGranted = scopeStr
    ? scopeStr.split(/[\s,]+|%20/).filter(Boolean)
    : (fallbackScopes ?? []);

  return { accessToken, refreshToken, expiresAt, scopesGranted };
}
