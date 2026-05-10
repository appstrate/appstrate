// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth Model Providers — credential payload helpers.
 *
 * Two purposes:
 *   1. Decode the JWT claims that ship inside the access tokens (Codex
 *      uses RS256 JWTs carrying `chatgpt_account_id`; Claude Code returns
 *      opaque `sk-ant-oat01-…` tokens with no embedded claims).
 *   2. Wrap the persisted credential blob shape consumed by the sidecar
 *      via the internal /internal/oauth-token/:connectionId endpoint.
 *
 * No verification is performed on the JWT signature — it is a passively
 * inspected payload. The token's authority comes from the OAuth dance
 * itself; signature verification happens server-side at the provider.
 */

export interface OAuthModelProviderCredentials {
  /** Raw access token. `sk-ant-oat01-…` for Claude, JWT RS256 for Codex. */
  access_token: string;
  /** Refresh token used to acquire a fresh access_token. */
  refresh_token: string;
  /** Token type as returned by the provider. Always "Bearer" in practice. */
  token_type?: "Bearer";
  /** Codex-only: extracted from JWT `https://api.openai.com/auth.chatgpt_account_id`. */
  chatgpt_account_id?: string;
  /** Claude-only: subscription tier (`pro`, `max`, `team`, `enterprise`). */
  subscription_type?: string;
  /** Optional account email for UI display. */
  email?: string;
}

/**
 * Decode the JWT payload of a Codex access token.
 *
 * Codex tokens are RS256 JWTs whose payload contains:
 *   - `https://api.openai.com/auth.chatgpt_account_id` (UUID)
 *   - `email`, `email_verified`
 *   - standard `iss`, `aud`, `exp`, `iat` claims
 *
 * Returns `null` if the token is not a JWT or the payload is malformed.
 * Does NOT verify the signature — the runtime trusts that the OAuth
 * dance produced this token; downstream Codex calls verify it server-side.
 */
export function decodeCodexJwtPayload(accessToken: string): {
  chatgpt_account_id?: string;
  email?: string;
} | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1]!;
    // base64url → base64
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf-8");
    const claims = JSON.parse(json) as Record<string, unknown>;

    const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const accountId =
      auth && typeof auth["chatgpt_account_id"] === "string"
        ? (auth["chatgpt_account_id"] as string)
        : undefined;
    const email = typeof claims["email"] === "string" ? (claims["email"] as string) : undefined;

    return { chatgpt_account_id: accountId, email };
  } catch {
    return null;
  }
}

/**
 * Extract subscription type from a Claude OAuth token response.
 *
 * Anthropic returns `subscription_type` in the token response body for
 * Pro/Max/Team accounts. The field is non-standard (not in RFC 6749) —
 * captured here at exchange time, then persisted with the credentials.
 */
export function readClaudeSubscriptionType(
  tokenResponse: Record<string, unknown>,
): string | undefined {
  const value = tokenResponse["subscription_type"];
  return typeof value === "string" ? value : undefined;
}

/**
 * Extract the user's email from the Claude OAuth token response.
 * Anthropic surfaces it in `account.email_address` for some flows.
 */
export function readClaudeEmail(tokenResponse: Record<string, unknown>): string | undefined {
  const direct = tokenResponse["email"];
  if (typeof direct === "string") return direct;
  const account = tokenResponse["account"] as Record<string, unknown> | undefined;
  if (account && typeof account["email_address"] === "string") {
    return account["email_address"] as string;
  }
  return undefined;
}
