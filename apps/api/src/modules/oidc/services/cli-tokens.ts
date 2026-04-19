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
import { cliRefreshToken, deviceCode, oauthClient } from "../schema.ts";
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
 *
 * ## Concurrency model
 *
 * Same shape as `rotateRefreshToken`: the entire validate → mint →
 * consume cycle runs inside `db.transaction` with a `SELECT … FOR
 * UPDATE` lock on the `device_codes` row. Two concurrent polls arriving
 * in the ms-wide window after approval serialize on the lock — one
 * wins, inserts the refresh-token child, deletes the device_codes row,
 * and commits; the second blocks until the first commits, then re-reads
 * and sees no row (the DELETE is already visible) → returns
 * `invalid_grant` on "Unknown or already-consumed device_code". Without
 * the lock both racers could pass the `status === "approved"` check and
 * mint two token pairs for the same device authorization, breaking the
 * one-shot contract RFC 8628 §3.5 requires.
 *
 * Side-effect commit strategy matches `rotateRefreshToken` too: we
 * return a tagged outcome rather than throwing inside the tx, so DELETE
 * sweeps for `denied` / `expired` states commit alongside the error
 * tag instead of rolling back into a stale "pending-like" row.
 */
export async function exchangeDeviceCodeForTokens(params: {
  deviceCodeValue: string;
  clientId: string;
}): Promise<TokenPair> {
  const { deviceCodeValue, clientId } = params;

  type ExchangeOutcome =
    | { kind: "ok"; pair: TokenPair }
    | { kind: "error"; code: CliTokenErrorCode; description: string };

  const outcome: ExchangeOutcome = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(deviceCode)
      .where(eq(deviceCode.deviceCode, deviceCodeValue))
      .limit(1)
      .for("update");

    if (!row) {
      return {
        kind: "error",
        code: "invalid_grant",
        description: "Unknown or already-consumed device_code.",
      };
    }
    if (row.clientId && row.clientId !== clientId) {
      // `client_id` swap between `/device/code` and `/cli/token` — treat
      // as `invalid_grant` per RFC 8628 §3.5 (same rubric BA uses).
      return {
        kind: "error",
        code: "invalid_grant",
        description: "client_id does not match device_code issuer.",
      };
    }

    // Polling-interval guard (RFC 8628 §5.5). BA's own `/device/token`
    // enforces this on the same row; we mirror it so a CLI cannot bypass
    // the throttle by calling our endpoint directly.
    if (row.lastPolledAt && row.pollingInterval) {
      const sinceLast = Date.now() - new Date(row.lastPolledAt).getTime();
      if (sinceLast < row.pollingInterval) {
        return {
          kind: "error",
          code: "slow_down",
          description: "Polling too frequently — back off per RFC 8628 §5.5.",
        };
      }
    }
    await tx.update(deviceCode).set({ lastPolledAt: new Date() }).where(eq(deviceCode.id, row.id));

    if (row.expiresAt < new Date()) {
      // Sweep the expired row so a subsequent poll doesn't linger on a
      // dead code. BA's handler has the same sweep — mirror it. The
      // DELETE commits with the tx because we return an error tag
      // rather than throwing.
      await tx.delete(deviceCode).where(eq(deviceCode.id, row.id));
      return {
        kind: "error",
        code: "expired_token",
        description: "Device code expired before approval.",
      };
    }
    if (row.status === "pending") {
      return {
        kind: "error",
        code: "authorization_pending",
        description: "Waiting for the user to approve.",
      };
    }
    if (row.status === "denied") {
      await tx.delete(deviceCode).where(eq(deviceCode.id, row.id));
      return {
        kind: "error",
        code: "access_denied",
        description: "User denied the authorization request.",
      };
    }
    if (row.status !== "approved" || !row.userId) {
      return {
        kind: "error",
        code: "server_error",
        description: "Device code in unexpected state.",
      };
    }

    // Load the approving user + a lightweight `emailVerified` column read.
    const [userRow] = await tx
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
      return {
        kind: "error",
        code: "server_error",
        description: "Approving user no longer exists.",
      };
    }

    // Defense-in-depth scope gate. BA's `deviceAuthorization()` plugin
    // stores whatever scope string the `/device/code` request posted —
    // there is no universal contract that it narrows the request to
    // the client's declared scope set before approval. Narrow it here
    // so a non-conforming (or future-regressed) plugin version cannot
    // silently mint a JWT with an unregistered scope. Drop unknown
    // tokens and audit the delta; DO NOT reject (RFC 6749 §3.3 permits
    // servers to issue a narrower scope than requested as long as the
    // response echoes what was actually granted).
    const [clientRow] = await tx
      .select({ scopes: oauthClient.scopes })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, clientId))
      .limit(1);
    const scope = narrowScopeToClient(row.scope ?? "", clientRow?.scopes ?? null, {
      clientId,
      userId: userRow.id,
    });
    const pair = await mintTokenPairInTx(tx, {
      user: userRow,
      clientId,
      scope,
      // No parent — head of a fresh family.
      parentId: null,
      familyId: prefixedId("crf"),
    });

    // One-shot contract: delete the device_codes row so a replay hits
    // `invalid_grant`. Same semantics as BA's default `/device/token`
    // handler. Committing this inside the tx alongside the refresh-token
    // INSERT is what makes the whole exchange atomic under contention.
    await tx.delete(deviceCode).where(eq(deviceCode.id, row.id));

    return { kind: "ok", pair };
  });

  if (outcome.kind === "ok") return outcome.pair;
  throw new CliTokenError(outcome.code, outcome.description);
}

/**
 * Rotate a refresh token. On success returns a fresh pair and marks
 * the presented token `used_at`. On reuse detection, revokes the
 * entire family and throws `invalid_grant`.
 *
 * ## Concurrency model
 *
 * Rotations of the same refresh token are serialized through a
 * `SELECT … FOR UPDATE` row lock on the parent inside a transaction.
 * Two concurrent requests with the same plaintext token land on the
 * same row → one wins the lock, performs `UPDATE used_at` + `INSERT
 * child`, commits; the second waits, sees `used_at` set after the
 * first commits, and enters the reuse branch which revokes the entire
 * family INCLUDING the winner's freshly-inserted child.
 *
 * Why the row lock (not just a conditional UPDATE): without the lock,
 * a loser could enter `revokeFamily` *before* the winner's child INSERT
 * commits. The revoke UPDATE targets rows with `revoked_at IS NULL`,
 * so a child inserted after that sweep would survive with usable
 * state — breaking RFC 6819 §5.2.2.3. The lock closes that window by
 * forcing the loser to wait until the winner's INSERT is visible.
 *
 * The reuse branch MUST NOT leak the reuse-vs-explicit-revoke
 * distinction to the presenter: an attacker replaying a stolen token
 * should get the same user-visible response as a legitimate CLI
 * presenting a token revoked server-side for some other reason
 * (logout elsewhere, reuse already detected by a peer, user deletion).
 * Only operators — via the audit log + the `revoked_reason` DB column
 * — see which branch fired. Expiry remains distinct because `exp` is
 * public information the CLI already computed at login time.
 */
export async function rotateRefreshToken(params: {
  refreshToken: string;
  clientId: string;
}): Promise<TokenPair> {
  const { refreshToken, clientId } = params;
  const tokenHash = hashRefreshToken(refreshToken);

  // The rotation transaction returns a tagged result rather than
  // throwing, because throwing inside `db.transaction(...)` rolls back
  // every statement inside — including the reuse-branch family revoke.
  // A rolled-back revoke would leave a stolen token reusable on retry.
  // We commit the tx with whatever state it determined, then decide
  // outside whether that outcome needs an exception or a second
  // (committed) revoke sweep.
  type RotationOutcome =
    | { kind: "ok"; pair: TokenPair }
    | {
        kind: "error";
        code: CliTokenErrorCode;
        description: string;
      }
    | {
        kind: "reuse";
        familyId: string;
        userId: string;
        clientId: string;
      };

  const outcome: RotationOutcome = await db.transaction(async (tx) => {
    // Lock the parent row for the duration of the transaction. Any
    // concurrent rotation of the same plaintext token blocks here
    // until we commit or rollback, at which point it re-reads the row
    // and sees our `used_at` mutation. This serialization closes the
    // TOCTOU window between the SELECT and the mark-UPDATE that
    // would otherwise let two racers both pass the `usedAt` guard.
    const [row] = await tx
      .select()
      .from(cliRefreshToken)
      .where(eq(cliRefreshToken.tokenHash, tokenHash))
      .limit(1)
      .for("update");

    if (!row) {
      return { kind: "error", code: "invalid_grant", description: "Unknown refresh token." };
    }
    if (row.clientId !== clientId) {
      return {
        kind: "error",
        code: "invalid_grant",
        description: "Refresh token was issued to a different client.",
      };
    }
    if (row.revokedAt) {
      return {
        kind: "error",
        code: "invalid_grant",
        description: "Refresh token has been revoked.",
      };
    }
    if (row.expiresAt < new Date()) {
      return {
        kind: "error",
        code: "invalid_grant",
        description: "Refresh token has expired.",
      };
    }
    if (row.usedAt) {
      // Signal reuse to the outer scope. The family-wide revoke runs
      // in a fresh transaction so a thrown error here (or an abort of
      // THIS tx for any reason) can't undo the revoke. See
      // RFC 6819 §5.2.2.3.
      return {
        kind: "reuse",
        familyId: row.familyId,
        userId: row.userId,
        clientId: row.clientId,
      };
    }

    const [userRow] = await tx
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
      return { kind: "error", code: "invalid_grant", description: "User no longer exists." };
    }

    // Mark-before-mint ordering: a crash between the UPDATE and the
    // INSERT leaves `used_at` set without a child row. A retry of the
    // same refresh token then trips the reuse branch and revokes the
    // family. Safe failure — no duplicated-usable state.
    await tx
      .update(cliRefreshToken)
      .set({ usedAt: new Date() })
      .where(eq(cliRefreshToken.id, row.id));

    const pair = await mintTokenPairInTx(tx, {
      user: userRow,
      clientId,
      scope: row.scope ?? "",
      parentId: row.id,
      familyId: row.familyId,
    });
    return { kind: "ok", pair };
  });

  if (outcome.kind === "ok") return outcome.pair;
  if (outcome.kind === "error") {
    throw new CliTokenError(outcome.code, outcome.description);
  }
  // outcome.kind === "reuse". Revoke the family in a fresh transaction
  // so it commits independently of the rotation tx. Because the
  // parent-row lock above serialized us with any concurrent winner,
  // their child row (if any) is already committed and visible to this
  // sweep → the `family_id` UPDATE covers it.
  await revokeFamily(outcome.familyId, "reuse");
  logger.warn("oidc: CLI refresh-token reuse detected — family revoked", {
    module: "oidc",
    audit: true,
    event: "cli.refresh_token.reuse",
    familyId: outcome.familyId,
    userId: outcome.userId,
    clientId: outcome.clientId,
  });
  throw new CliTokenError("invalid_grant", "Refresh token has been revoked.");
}

/**
 * Revoke a refresh token family. Idempotent — repeat calls are no-ops.
 * Called by `POST /api/auth/cli/revoke` (CLI logout) and by the
 * reuse-detection branch of `rotateRefreshToken`.
 *
 * Returns a discriminator so operators/audit logs can tell whether the
 * revoke actually touched a family or was a no-op (unknown token /
 * client mismatch). The `/cli/revoke` HTTP endpoint intentionally
 * discards this distinction and returns `{ revoked: true }` on every
 * 200 response — RFC 7009 §2.2 requires 200 even for invalid tokens,
 * and leaking the hit/miss bit to the caller is a narrow but real
 * oracle on a 256-bit token space.
 */
export async function revokeRefreshToken(params: {
  refreshToken: string;
  clientId: string;
}): Promise<{ revoked: boolean }> {
  const tokenHash = hashRefreshToken(params.refreshToken);
  const [row] = await db
    .select({
      familyId: cliRefreshToken.familyId,
      clientId: cliRefreshToken.clientId,
      userId: cliRefreshToken.userId,
    })
    .from(cliRefreshToken)
    .where(eq(cliRefreshToken.tokenHash, tokenHash))
    .limit(1);
  if (!row) return { revoked: false };
  if (row.clientId !== params.clientId) {
    // Audit log the cross-client presentation so operators can still spot
    // a compromised token surfacing from an unexpected client — the HTTP
    // response intentionally hides the distinction, so the log is the
    // only channel that surfaces the miss.
    logger.warn("oidc: CLI refresh-token revoke with client mismatch — ignored", {
      module: "oidc",
      audit: true,
      event: "cli.refresh_token.revoke.client_mismatch",
      expectedClientId: row.clientId,
      presentedClientId: params.clientId,
      userId: row.userId,
    });
    return { revoked: false };
  }
  await revokeFamily(row.familyId, "logout");
  return { revoked: true };
}

async function revokeFamily(familyId: string, reason: string): Promise<void> {
  await db
    .update(cliRefreshToken)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(cliRefreshToken.familyId, familyId), isNull(cliRefreshToken.revokedAt)));
}

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Mint a JWT access token + refresh-token row inside a caller-supplied
 * Drizzle transaction handle. The refresh-token INSERT commits atomically
 * with whatever the caller wrapped the tx around (`used_at` mark on the
 * parent row in `rotateRefreshToken`, DELETE of the device_codes row in
 * `exchangeDeviceCodeForTokens`). Both callers hold the relevant
 * FOR-UPDATE lock so a concurrent reuse-detection or duplicate-exchange
 * racer either sees the committed INSERT and revokes it, or hasn't
 * started yet because it's blocked on the lock.
 */
async function mintTokenPairInTx(
  tx: DbOrTx,
  params: {
    user: { id: string; email: string; name: string | null; emailVerified: boolean };
    clientId: string;
    scope: string;
    parentId: string | null;
    familyId: string;
  },
): Promise<TokenPair> {
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
  await tx.insert(cliRefreshToken).values({
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
  // Strip any trailing slash from APP_URL before composing iss/aud so
  // a misconfigured `APP_URL=https://app.example.com/` doesn't yield a
  // double-slash issuer (`https://app.example.com//api/auth`) that
  // fails the strict JOSE equality check downstream consumers apply.
  const baseUrl = env.APP_URL.replace(/\/+$/, "");
  const iss = `${baseUrl}/api/auth`;
  // Match `enduser-token.ts::verifyEndUserAccessToken` audience list —
  // it accepts either `APP_URL` or `${APP_URL}/api/auth`. Emit the more
  // specific form (matching BA's `baseURL`-derived default) so any
  // future tightening that drops the bare `APP_URL` still passes.
  const aud = iss;
  const nowSec = Math.floor(Date.now() / 1000);
  // RFC 6749 §3.3 / RFC 9068 §3: omit the `scope` claim entirely when
  // the grant carries no scopes rather than emitting `scope: ""`.
  // Some RS implementations treat an empty string as "wildcard" /
  // "default scopes" instead of "no scope" — omitting the claim is the
  // unambiguous encoding.
  const payload: Record<string, unknown> = {
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
  };
  if (claims.scope.length > 0) {
    payload.scope = claims.scope;
  }
  const api = getOidcAuthApi();
  const result = (await api.signJWT({
    body: { payload, overrideOptions: { jwt: { issuer: iss, audience: aud } } },
    headers: new Headers(),
  })) as { token?: string } | Response;
  // When called directly (not through HTTP), the BA endpoint returns the
  // JSON object. When asResponse was requested it returns a Response.
  // Handle both for safety.
  if (result instanceof Response) {
    const body = (await result.json()) as { token: string };
    return body.token;
  }
  const token = result.token;
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

/**
 * Intersect the scope string persisted on the device_code row with the
 * scopes declared on the OAuth client row. Returns a space-separated
 * subset in original request order (deduplicated). Unknown scopes are
 * dropped and audit-logged so operators can spot a misconfigured
 * upstream or a crafted `/device/code` that slipped past BA's plugin.
 *
 * Empty-client-scopes (NULL or `[]`) is treated as "no restriction"
 * ONLY when the client is explicitly declared without a `scopes`
 * column — the allowlist below defaults to the canonical CLI scope
 * set so a misseeded client cannot accidentally widen grants. Callers
 * that actually want unrestricted minting (admin tooling, etc.) should
 * declare their scopes explicitly.
 */
function narrowScopeToClient(
  requested: string,
  clientScopes: string[] | null,
  ctx: { clientId: string; userId: string },
): string {
  const tokens = requested.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  // Absence of a declared scope set is surprising for any client that
  // has made it through `/device/code` — BA's plugin writes the scope
  // string as-posted. Fail closed (empty scope) and audit, rather than
  // echoing an un-gated `scope` claim into the JWT.
  if (!clientScopes || clientScopes.length === 0) {
    logger.warn("oidc: CLI device-code exchange — client has no declared scopes, dropping all", {
      module: "oidc",
      audit: true,
      event: "cli.device_code.scope.dropped",
      clientId: ctx.clientId,
      userId: ctx.userId,
      requested: tokens,
    });
    return "";
  }
  const allowed = new Set(clientScopes);
  const granted: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (allowed.has(t)) granted.push(t);
    else dropped.push(t);
  }
  if (dropped.length > 0) {
    logger.warn("oidc: CLI device-code exchange — dropped scope tokens not declared on client", {
      module: "oidc",
      audit: true,
      event: "cli.device_code.scope.dropped",
      clientId: ctx.clientId,
      userId: ctx.userId,
      requested: tokens,
      granted,
      dropped,
    });
  }
  return granted.join(" ");
}

// Test-only surface. Exposed for unit tests that need to inject known
// refresh-token plaintexts without re-deriving the hash from scratch.
export const _hashRefreshTokenForTesting = hashRefreshToken;
export const _generateRefreshTokenForTesting = generateRefreshToken;
export const _narrowScopeToClientForTesting = narrowScopeToClient;
