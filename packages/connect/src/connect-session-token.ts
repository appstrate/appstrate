// SPDX-License-Identifier: Apache-2.0
/**
 * Connect-session tokens — short-lived, HMAC-signed capability tokens that
 * authorize a single hosted-connect-portal flow.
 *
 * The token is the ONLY source of context for the hosted connect page
 * (`GET /connect`). It is minted by the platform when an agent (or any client)
 * asks to connect/reconnect an integration, then carried in the connect URL.
 * The page exchanges it once for a page-scoped cookie; the credential secret
 * itself never rides the token or the query string.
 *
 * Design mirrors the SOTA hosted-portal pattern (Nango Connect session,
 * Paragon User Token): a backend-minted, scoped, short-TTL token — never the
 * API key, never the model — gates the unified connect surface.
 *
 * Format: `base64url(JSON payload).base64url(HMAC-SHA256)` — the shared
 * keyring-HMAC codec (`@appstrate/afps-shared/signed-token`), under this
 * module's own domain.
 *
 * Secret is injected by the caller (`CONNECT_SESSION_SECRET`), kept separate
 * from other signing secrets so it can be rotated independently. A
 * comma-separated keyring enables online rotation: the FIRST key signs new
 * tokens, ALL keys verify. Each key must be ≥16 chars (and thus comma-free).
 */
import { signKeyringToken, verifyKeyringToken } from "@appstrate/afps-shared/signed-token";

/**
 * HMAC domain separator. The secret is already dedicated to this flow, so the
 * domain is belt-and-braces — but it is what keeps that isolation true if the
 * deployment ever points `CONNECT_SESSION_SECRET` at a shared keyring.
 */
const CONNECT_SESSION_DOMAIN = "connect-session.v1.";

/**
 * Claims encoded inside a connect-session token. Exactly one actor field
 * (`user_id` for a platform member, `end_user_id` for an embedded end-user)
 * MUST be present — enforced at mint and re-checked at verify.
 */
export interface ConnectSessionClaims {
  /** Schema version. */
  v: 1;
  /** Organization the connection belongs to. */
  org_id: string;
  /** Space scope. */
  space_id: string;
  /** Platform member actor (mutually exclusive with `end_user_id`). */
  user_id?: string;
  /** Embedded end-user actor (`eu_…`, mutually exclusive with `user_id`). */
  end_user_id?: string;
  /** Integration package id (`@scope/name`). */
  package_id: string;
  /** Auth key within the integration manifest. */
  auth_key: string;
  /** Present = reconnect/upgrade an existing connection in place. */
  connection_id?: string;
  /** OAuth scopes the caller forwards (agent-inferred required scopes). */
  scopes?: string[];
  /** Force the provider's account picker on the OAuth screen (oauth2 only). */
  force_account_select?: boolean;
  /** Single-use replay-guard id (consumed server-side, e.g. via Redis). */
  jti: string;
  /**
   * Double-submit CSRF nonce — set only on the page-cookie variant of the
   * token (minted after the initial capability token is consumed). The hosted
   * form echoes it back in a header on submit.
   */
  csrf?: string;
  /** Expiration unix timestamp (seconds). */
  exp: number;
}

function hasExactlyOneActor(c: { user_id?: string; end_user_id?: string }): boolean {
  return Boolean(c.user_id) !== Boolean(c.end_user_id);
}

/**
 * Encode + HMAC-sign a connect-session token with the FIRST key of the keyring.
 * Throws if no signing key is configured or the actor invariant is violated.
 */
export function mintConnectSession(
  claims: ConnectSessionClaims,
  secret: string | readonly string[],
): string {
  if (!hasExactlyOneActor(claims)) {
    throw new Error("mintConnectSession requires exactly one of user_id / end_user_id");
  }
  return signKeyringToken(CONNECT_SESSION_DOMAIN, claims, secret);
}

/**
 * Verify + decode a connect-session token. Returns the claims on success, null
 * on any failure (bad signature, malformed, expired, missing/ambiguous actor).
 * Verifies against EVERY key of the keyring (constant-time per key) so tokens
 * signed before a rotation stay valid. Single-use enforcement (`jti`) is the
 * caller's responsibility — this helper is stateless.
 */
export function verifyConnectSession(
  token: string,
  secret: string | readonly string[],
): ConnectSessionClaims | null {
  const claims = verifyKeyringToken<ConnectSessionClaims>(CONNECT_SESSION_DOMAIN, token, secret);
  if (!claims) return null;

  if (claims.v !== 1) return null;
  if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) return null;
  if (typeof claims.jti !== "string" || !claims.jti) return null;
  if (typeof claims.org_id !== "string" || !claims.org_id) return null;
  if (typeof claims.space_id !== "string" || !claims.space_id) return null;
  if (typeof claims.package_id !== "string" || !claims.package_id) return null;
  if (typeof claims.auth_key !== "string" || !claims.auth_key) return null;
  if (!hasExactlyOneActor(claims)) return null;
  return claims;
}
