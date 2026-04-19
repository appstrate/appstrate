// SPDX-License-Identifier: Apache-2.0

/**
 * CLI token service (issue #165).
 *
 * Replaces the 7-day Better Auth session token returned by BA's
 * `/device/token` endpoint with a **15-minute signed JWT access token +
 * 30-day opaque rotating refresh token** pair. Follows RFC 6749
 * §1.5 semantics + RFC 6819 §5.2.2.3 reuse detection.
 *
 * ## Why a separate endpoint instead of intercepting `/device/token`?
 *
 * Better Auth's `deviceAuthorization()` plugin hard-codes `/device/token`
 * to return a BA session via `ctx.context.internalAdapter.createSession()`.
 * There is no hook to substitute the response body. Rather than monkey-
 * patching the plugin or deleting its endpoint, this module exposes a
 * *parallel* endpoint at `/api/auth/cli/token` that:
 *
 *   1. Reads the BA-owned `device_codes` table directly via Drizzle.
 *   2. Validates status / expiry / polling interval identically to BA's
 *      own handler (same error vocabulary — `authorization_pending`,
 *      `slow_down`, `expired_token`, `access_denied`, `invalid_grant`).
 *   3. On success, mints a JWT access token (ES256, via the JWKS the
 *      `jwt()` plugin already maintains) + an opaque refresh token
 *      stored in `cli_refresh_tokens`.
 *   4. Deletes the `device_codes` row to preserve the one-shot contract.
 *
 * The old `/device/token` endpoint remains reachable for backward
 * compatibility but is no longer used by the CLI.
 *
 * ## Access token shape
 *
 * Matches the existing oauth-provider instance-level token format
 * (`services/enduser-token.ts::verifyEndUserAccessToken` already accepts
 * it) so the `oidcAuthStrategy` Bearer path resolves the caller as an
 * instance user without strategy changes:
 *
 *   iss: `${APP_URL}/api/auth`
 *   aud: `${APP_URL}/api/auth`
 *   sub: BA user id
 *   azp: `appstrate-cli`
 *   actor_type: "user"
 *   email, email_verified, name
 *   scope: the scope string requested via `/device/code`
 *   iat / exp: 15 min window
 *   jti: random 128-bit hex (for `Bearer ey...` token blacklist if ever needed)
 *
 * ## Refresh token shape
 *
 * 32 bytes of CSPRNG → base64url (43 chars). Never persisted in
 * plaintext — we hash with SHA-256 and store the hex digest in
 * `cli_refresh_tokens.token_hash` (unique index). The returned plaintext
 * is the only copy the CLI ever sees. An operator with read access to
 * the DB cannot replay a token; they can only revoke families.
 *
 * ## Rotation + reuse detection
 *
 * A refresh_token grant rotates: the presented token is marked `used_at`
 * and a NEW row is inserted with the same `family_id` and the old row's
 * `id` as `parent_id`. If a CLI ever presents a token whose `used_at` is
 * already set, the presenter is either the legitimate CLI presenting a
 * stored copy AFTER the peer already rotated (unlikely), or an attacker
 * who stole the pre-rotation token and is racing the legit CLI (the
 * attack RFC 6819 §5.2.2.3 describes). Both hit the same response: the
 * entire `family_id` is revoked, and the CLI must re-authenticate via
 * device flow.
 */

import { randomBytes, createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getEnv } from "@appstrate/env";
import { db } from "@appstrate/db/client";
import { user as userTable } from "@appstrate/db/schema";
import { cliRefreshToken, deviceCode } from "../schema.ts";
import { prefixedId } from "../../../lib/ids.ts";
import { logger } from "../../../lib/logger.ts";
import { getOidcAuthApi } from "../auth/api.ts";

/** 15 minutes — the industry-standard short-lived access token window
 *  (gh, gcloud, aws sso all sit in the 15 min – 1 h band). Tight enough
 *  that a leaked token stored on disk has a narrow replay window; loose
 *  enough that a CLI in an interactive REPL doesn't refresh every call. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** 30 days — industry-standard rotating refresh window. A CLI left idle
 *  longer than 30 days forces a re-run of `appstrate login`, which is
 *  aligned with session-management SOTA (Google, GitHub, AWS SSO all cap
 *  offline access at 30 d for public clients). */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export class CliTokenError extends Error {
  constructor(
    public readonly code: CliTokenErrorCode,
    public readonly description: string,
  ) {
    super(description);
    this.name = "CliTokenError";
  }
}

/** RFC 6749 / RFC 8628 error codes the CLI callers render directly. */
export type CliTokenErrorCode =
  | "authorization_pending"
  | "slow_down"
  | "expired_token"
  | "access_denied"
  | "invalid_request"
  | "invalid_grant"
  | "invalid_client"
  | "server_error";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /** Seconds until the refresh token expires. */
  refreshExpiresIn: number;
  tokenType: "Bearer";
  /** Space-separated scope that was granted. */
  scope: string;
}

/**
 * Exchange an approved device code for a JWT + refresh pair. Called by
 * the BA plugin `/cli/token` endpoint after device-flow approval.
 *
 * The caller MUST have already validated `client_id` existence + the
 * device-code grant registration — this service only validates the
 * device-code row itself.
 */
export async function exchangeDeviceCodeForTokens(params: {
  deviceCodeValue: string;
  clientId: string;
}): Promise<TokenPair> {
  const { deviceCodeValue, clientId } = params;

  const [row] = await db
    .select()
    .from(deviceCode)
    .where(eq(deviceCode.deviceCode, deviceCodeValue))
    .limit(1);

  if (!row) {
    throw new CliTokenError("invalid_grant", "Unknown or already-consumed device_code.");
  }
  if (row.clientId && row.clientId !== clientId) {
    // `client_id` swap between `/device/code` and `/cli/token` — treat
    // as `invalid_grant` per RFC 8628 §3.5 (same rubric BA uses).
    throw new CliTokenError("invalid_grant", "client_id does not match device_code issuer.");
  }

  // Polling-interval guard (RFC 8628 §5.5). BA's own `/device/token`
  // enforces this on the same row; we mirror it so a CLI cannot bypass
  // the throttle by calling our endpoint directly.
  if (row.lastPolledAt && row.pollingInterval) {
    const sinceLast = Date.now() - new Date(row.lastPolledAt).getTime();
    if (sinceLast < row.pollingInterval) {
      throw new CliTokenError("slow_down", "Polling too frequently — back off per RFC 8628 §5.5.");
    }
  }
  await db.update(deviceCode).set({ lastPolledAt: new Date() }).where(eq(deviceCode.id, row.id));

  if (row.expiresAt < new Date()) {
    // Sweep the expired row so a subsequent poll doesn't linger on a
    // dead code. BA's handler has the same sweep — mirror it.
    await db.delete(deviceCode).where(eq(deviceCode.id, row.id));
    throw new CliTokenError("expired_token", "Device code expired before approval.");
  }
  if (row.status === "pending") {
    throw new CliTokenError("authorization_pending", "Waiting for the user to approve.");
  }
  if (row.status === "denied") {
    await db.delete(deviceCode).where(eq(deviceCode.id, row.id));
    throw new CliTokenError("access_denied", "User denied the authorization request.");
  }
  if (row.status !== "approved" || !row.userId) {
    throw new CliTokenError("server_error", "Device code in unexpected state.");
  }

  // Load the approving user + a lightweight `emailVerified` column read.
  const [userRow] = await db
    .select({
      id: userTable.id,
      email: userTable.email,
      name: userTable.name,
      emailVerified: userTable.emailVerified,
    })
    .from(userTable)
    .where(eq(userTable.id, row.userId))
    .limit(1);
  if (!userRow) {
    throw new CliTokenError("server_error", "Approving user no longer exists.");
  }

  const scope = row.scope ?? "";
  const tokens = await mintTokenPair({
    user: userRow,
    clientId,
    scope,
    // No parent — head of a fresh family.
    parentId: null,
    familyId: prefixedId("crf"),
  });

  // One-shot contract: delete the device_codes row so a replay hits
  // `invalid_grant`. Same semantics as BA's default `/device/token`
  // handler.
  await db.delete(deviceCode).where(eq(deviceCode.id, row.id));

  return tokens;
}

/**
 * Rotate a refresh token. On success returns a fresh pair and marks
 * the presented token `used_at`. On reuse detection, revokes the
 * entire family and throws `invalid_grant`.
 */
export async function rotateRefreshToken(params: {
  refreshToken: string;
  clientId: string;
}): Promise<TokenPair> {
  const { refreshToken, clientId } = params;

  const tokenHash = hashRefreshToken(refreshToken);
  const [row] = await db
    .select()
    .from(cliRefreshToken)
    .where(eq(cliRefreshToken.tokenHash, tokenHash))
    .limit(1);

  if (!row) {
    throw new CliTokenError("invalid_grant", "Unknown refresh token.");
  }
  if (row.clientId !== clientId) {
    throw new CliTokenError("invalid_grant", "Refresh token was issued to a different client.");
  }
  if (row.revokedAt) {
    // Already revoked — could be the result of a prior reuse-detection
    // sweep. Stay silent about the reason (don't leak reuse-vs-explicit
    // distinction to the presenter).
    throw new CliTokenError("invalid_grant", "Refresh token has been revoked.");
  }
  if (row.expiresAt < new Date()) {
    throw new CliTokenError("invalid_grant", "Refresh token has expired.");
  }
  if (row.usedAt) {
    // Reuse detection — RFC 6819 §5.2.2.3. Revoke the entire family so
    // neither the legitimate holder (who raced) nor the attacker (who
    // stole a pre-rotation copy) retains access. The user must re-run
    // `appstrate login`.
    await revokeFamily(row.familyId, "reuse");
    logger.warn("oidc: CLI refresh-token reuse detected — family revoked", {
      module: "oidc",
      audit: true,
      event: "cli.refresh_token.reuse",
      familyId: row.familyId,
      userId: row.userId,
      clientId: row.clientId,
    });
    throw new CliTokenError(
      "invalid_grant",
      "Refresh token reuse detected — all sessions in this family have been revoked.",
    );
  }

  // Load approving user to mint a fresh access token.
  const [userRow] = await db
    .select({
      id: userTable.id,
      email: userTable.email,
      name: userTable.name,
      emailVerified: userTable.emailVerified,
    })
    .from(userTable)
    .where(eq(userTable.id, row.userId))
    .limit(1);
  if (!userRow) {
    throw new CliTokenError("invalid_grant", "User no longer exists.");
  }

  // Mark old row used BEFORE minting the new one so a crash between
  // mint + mark would result in a "new token present + old not used",
  // which then racing the legitimate CLI would trip reuse detection on
  // the attacker's side — still safe. The opposite order (mint after
  // mark) would occasionally leak an unusable new token if mint failed,
  // forcing a fresh login; less bad than duplicated-usable state.
  await db
    .update(cliRefreshToken)
    .set({ usedAt: new Date() })
    .where(eq(cliRefreshToken.id, row.id));

  return mintTokenPair({
    user: userRow,
    clientId,
    scope: row.scope ?? "",
    parentId: row.id,
    familyId: row.familyId,
  });
}

/**
 * Revoke a refresh token family. Idempotent — repeat calls are no-ops.
 * Called by `POST /api/auth/cli/revoke` (CLI logout) and by the
 * reuse-detection branch of `rotateRefreshToken`.
 */
export async function revokeRefreshToken(params: {
  refreshToken: string;
  clientId: string;
}): Promise<{ revoked: boolean }> {
  const tokenHash = hashRefreshToken(params.refreshToken);
  const [row] = await db
    .select({ familyId: cliRefreshToken.familyId, clientId: cliRefreshToken.clientId })
    .from(cliRefreshToken)
    .where(eq(cliRefreshToken.tokenHash, tokenHash))
    .limit(1);
  if (!row) return { revoked: false };
  if (row.clientId !== params.clientId) return { revoked: false };
  await revokeFamily(row.familyId, "logout");
  return { revoked: true };
}

async function revokeFamily(familyId: string, reason: string): Promise<void> {
  await db
    .update(cliRefreshToken)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(cliRefreshToken.familyId, familyId), isNull(cliRefreshToken.revokedAt)));
}

async function mintTokenPair(params: {
  user: { id: string; email: string; name: string | null; emailVerified: boolean };
  clientId: string;
  scope: string;
  parentId: string | null;
  familyId: string;
}): Promise<TokenPair> {
  const { user, clientId, scope, parentId, familyId } = params;

  // 1. Mint JWT access token.
  const accessToken = await mintAccessJwt({
    userId: user.id,
    email: user.email,
    name: user.name ?? user.email,
    emailVerified: user.emailVerified === true,
    scope,
    clientId,
  });

  // 2. Mint opaque refresh token + store.
  const refreshPlain = generateRefreshToken();
  const refreshHash = hashRefreshToken(refreshPlain);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
  await db.insert(cliRefreshToken).values({
    id: prefixedId("crf"),
    tokenHash: refreshHash,
    userId: user.id,
    clientId,
    familyId,
    parentId,
    scope,
    expiresAt,
    createdAt: new Date(),
    usedAt: null,
    revokedAt: null,
    revokedReason: null,
  });

  return {
    accessToken,
    refreshToken: refreshPlain,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    refreshExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
    tokenType: "Bearer",
    scope,
  };
}

/**
 * Mint an ES256 JWT using Better Auth's `jwt()` plugin so the claims,
 * issuer, audience, and `kid` match what `verifyEndUserAccessToken`
 * expects. Same JWKS the `/oauth2/token` flow uses → zero verifier-side
 * changes needed.
 */
async function mintAccessJwt(claims: {
  userId: string;
  email: string;
  name: string;
  emailVerified: boolean;
  scope: string;
  clientId: string;
}): Promise<string> {
  const env = getEnv();
  const iss = `${env.APP_URL}/api/auth`;
  // Match `enduser-token.ts::verifyEndUserAccessToken` audience list —
  // it accepts either `APP_URL` or `${APP_URL}/api/auth`. Emit the more
  // specific form (matching BA's `baseURL`-derived default) so any
  // future tightening that drops the bare `APP_URL` still passes.
  const aud = iss;
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    // RFC 7519 registered claims
    iss,
    aud,
    sub: claims.userId,
    iat: nowSec,
    exp: nowSec + ACCESS_TOKEN_TTL_SECONDS,
    jti: randomBytes(16).toString("hex"),
    // oauth-provider compatible custom claims
    azp: claims.clientId,
    actor_type: "user" as const,
    email: claims.email,
    email_verified: claims.emailVerified,
    name: claims.name,
    scope: claims.scope,
  };
  const api = getOidcAuthApi();
  const result = (await api.signJWT({
    body: { payload, overrideOptions: { jwt: { issuer: iss, audience: aud } } },
    headers: new Headers(),
  })) as { token?: string } | { token: string } | Response;
  // When called directly (not through HTTP), the BA endpoint returns the
  // JSON object. When asResponse was requested it returns a Response.
  // Handle both for safety.
  if (result instanceof Response) {
    const body = (await result.json()) as { token: string };
    return body.token;
  }
  const token = (result as { token?: string }).token;
  if (!token) {
    throw new Error("oidc: jwt signer returned no token");
  }
  return token;
}

/**
 * 32 bytes of CSPRNG → base64url (no padding). 256 bits of entropy,
 * 43 visible chars. Guaranteed unique for all practical purposes, but
 * the `cli_refresh_tokens.token_hash` UNIQUE index is the authoritative
 * uniqueness check.
 */
function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256(token) → hex. Deterministic, collision-resistant, fast. */
function hashRefreshToken(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

// Test-only surface. Exposed for unit tests that need to inject known
// refresh-token plaintexts without re-deriving the hash from scratch.
export const _hashRefreshTokenForTesting = hashRefreshToken;
export const _generateRefreshTokenForTesting = generateRefreshToken;
