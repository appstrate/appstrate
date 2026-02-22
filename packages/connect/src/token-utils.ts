/**
 * Shared token response parsing utilities.
 * Used by both oauth.ts (initial token exchange) and token-refresh.ts (refresh flow).
 */

export interface ParsedTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string | null;
  scopesGranted: string[];
}

/**
 * Parse a standard OAuth2 token endpoint response.
 *
 * @param tokenData - Raw JSON response from the token endpoint
 * @param scopeSeparator - Character used to split scope strings (default: " ")
 * @param fallbackScopes - Scopes to use if none are returned in the response
 * @param fallbackRefreshToken - Refresh token to preserve if not present in response
 */
export function parseTokenResponse(
  tokenData: Record<string, unknown>,
  scopeSeparator = " ",
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

  // Extract granted scopes
  const scopeStr = typeof tokenData.scope === "string" ? tokenData.scope : "";
  const scopesGranted = scopeStr
    ? scopeStr.split(scopeSeparator).filter(Boolean)
    : (fallbackScopes ?? []);

  return { accessToken, refreshToken, expiresAt, scopesGranted };
}
