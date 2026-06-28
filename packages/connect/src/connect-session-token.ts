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
 * Format: `base64url(JSON payload).base64url(HMAC-SHA256)` — identical wire
 * shape to the FS upload token (`@appstrate/core/storage-fs`).
 *
 * Secret is injected by the caller (`CONNECT_SESSION_SECRET`), kept separate
 * from other signing secrets so it can be rotated independently. A
 * comma-separated keyring enables online rotation: the FIRST key signs new
 * tokens, ALL keys verify. Each key must be ≥16 chars (and thus comma-free).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

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
  /** Application scope. */
  application_id: string;
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
  /** Single-use replay-guard id (consumed server-side, e.g. via Redis). */
  jti: string;
  /** Expiration unix timestamp (seconds). */
  exp: number;
}

function toKeyring(secret: string | readonly string[]): string[] {
  const keys = typeof secret === "string" ? secret.split(",") : [...secret];
  return keys.filter((k) => k.length > 0);
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
  const [activeKey] = toKeyring(secret);
  if (!activeKey) throw new Error("mintConnectSession requires at least one signing key");
  if (!hasExactlyOneActor(claims)) {
    throw new Error("mintConnectSession requires exactly one of user_id / end_user_id");
  }
  const body = Buffer.from(JSON.stringify(claims), "utf-8").toString("base64url");
  const sig = createHmac("sha256", activeKey).update(body).digest("base64url");
  return `${body}.${sig}`;
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
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const a = Buffer.from(sig);
  let valid = false;
  for (const key of toKeyring(secret)) {
    const b = Buffer.from(createHmac("sha256", key).update(body).digest("base64url"));
    if (a.length === b.length && timingSafeEqual(a, b)) {
      valid = true;
      break;
    }
  }
  if (!valid) return null;

  let claims: ConnectSessionClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as ConnectSessionClaims;
  } catch {
    return null;
  }

  if (claims.v !== 1) return null;
  if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) return null;
  if (typeof claims.jti !== "string" || !claims.jti) return null;
  if (typeof claims.org_id !== "string" || !claims.org_id) return null;
  if (typeof claims.application_id !== "string" || !claims.application_id) return null;
  if (typeof claims.package_id !== "string" || !claims.package_id) return null;
  if (typeof claims.auth_key !== "string" || !claims.auth_key) return null;
  if (!hasExactlyOneActor(claims)) return null;
  return claims;
}
