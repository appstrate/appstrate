// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth Model Providers — credential payload helpers.
 *
 * Codex access tokens are RS256 JWTs carrying `chatgpt_account_id`; the
 * sidecar needs that id as a per-request header. Claude Code returns opaque
 * `sk-ant-oat01-…` tokens with no embedded claims — its account email and
 * subscription tier are passed through from the CLI request body, not
 * server-decoded, so no Claude helpers live here.
 *
 * No verification is performed on the JWT signature — it is a passively
 * inspected payload. The token's authority comes from the OAuth dance
 * itself; signature verification happens server-side at the provider.
 */

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
