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
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getEnv } from "@appstrate/env";
import { db } from "@appstrate/db/client";
import { user as userTable, organizationMembers } from "@appstrate/db/schema";
import { cliRefreshToken, deviceCode, oauthClient } from "../schema.ts";
import { prefixedId } from "../../../lib/ids.ts";
import { logger } from "../../../lib/logger.ts";
import { getOidcAuthApi } from "../auth/api.ts";
import { getErrorMessage } from "@appstrate/core/errors";

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
 * Device metadata captured at device-code exchange. Persisted on the head
 * of family for the listing/revocation UI (issue #251). All fields
 * optional — pre-2.x CLIs that omit `X-Appstrate-Device-Name`, and
 * deployments where `getClientIpFromRequest` returns `null` (no
 * forwarded header trusted, no socket address surfaced), will produce
 * rows with partial metadata.
 */
export interface DeviceMetadata {
  /** Optional user-supplied label (`X-Appstrate-Device-Name`). */
  deviceName?: string | null;
  /** Raw `User-Agent` header at exchange/rotation time. */
  userAgent?: string | null;
  /** Resolved client IP, honors `TRUST_PROXY`. */
  ip?: string | null;
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
  metadata?: DeviceMetadata;
}): Promise<TokenPair> {
  const { deviceCodeValue, clientId, metadata } = params;

  // Two-phase exchange. Minting the JWT calls Better Auth's `signJWT`
  // plugin which issues its own DB reads via the BA adapter; nesting
  // that call inside a Drizzle `db.transaction(...)` deadlocks on
  // PGlite's single-connection embedded mode — the adapter's query
  // queues behind our own transaction, which can't commit until the
  // adapter query returns. PostgreSQL pools dodge this because BA
  // gets its own connection. The fix: do the read-and-validate work
  // inside a short transaction, mint the JWT OUTSIDE, then persist
  // the refresh token + consume the device_code row in a second
  // transaction with `FOR UPDATE` to preserve the one-shot contract.
  type ReadOutcome =
    | {
        kind: "ok";
        rowId: string;
        user: { id: string; email: string; name: string | null; emailVerified: boolean };
        scope: string;
      }
    | { kind: "error"; code: CliTokenErrorCode; description: string };

  const readOutcome: ReadOutcome = await db.transaction(async (tx) => {
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
      return {
        kind: "error",
        code: "invalid_grant",
        description: "client_id does not match device_code issuer.",
      };
    }

    // Polling-interval guard (RFC 8628 §5.5).
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

    const [clientRow] = await tx
      .select({ scopes: oauthClient.scopes })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, clientId))
      .limit(1);
    const scope = narrowScopeToClient(row.scope ?? "", clientRow?.scopes ?? null, {
      clientId,
      userId: userRow.id,
    });
    return { kind: "ok", rowId: row.id, user: userRow, scope };
  });

  if (readOutcome.kind === "error") {
    throw new CliTokenError(readOutcome.code, readOutcome.description);
  }
  const { rowId, user, scope } = readOutcome;

  // Pre-compute the family id so we can stamp it on the JWT (for
  // server-side revocation enforcement on every Bearer call) AND on the
  // refresh-token head row inserted below. Both must agree.
  const familyId = prefixedId("crf");

  // JWT mint OUTSIDE any transaction — goes through BA's jwt() plugin
  // which opens its own DB queries via the BA adapter.
  const accessToken = await mintAccessJwt({
    userId: user.id,
    email: user.email,
    name: user.name ?? user.email,
    emailVerified: user.emailVerified === true,
    scope,
    clientId,
    cliFamilyId: familyId,
  });

  // Second transaction: persist refresh token + consume device_code row
  // atomically. Re-verify the device_code row still exists to guard
  // against a racing consumer (both concurrent polls would pass the
  // first tx; FOR UPDATE here ensures only one persists).
  const persistOutcome: ExchangeOutcome = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: deviceCode.id })
      .from(deviceCode)
      .where(eq(deviceCode.id, rowId))
      .limit(1)
      .for("update");
    if (!row) {
      return {
        kind: "error",
        code: "invalid_grant",
        description: "Device code already consumed.",
      };
    }
    const { refreshPlain } = await persistRefreshTokenInTx(tx, {
      userId: user.id,
      clientId,
      scope,
      // No parent — head of a fresh family. Device metadata is persisted
      // on this head row only; rotation rows leave the columns NULL.
      parentId: null,
      familyId,
      metadata,
    });
    // One-shot contract.
    await tx.delete(deviceCode).where(eq(deviceCode.id, rowId));
    return { kind: "ok", pair: tokenPairResponse(accessToken, refreshPlain, scope) };
  });

  if (persistOutcome.kind === "error") {
    throw new CliTokenError(persistOutcome.code, persistOutcome.description);
  }
  return persistOutcome.pair;
}

type ExchangeOutcome =
  | { kind: "ok"; pair: TokenPair }
  | { kind: "error"; code: CliTokenErrorCode; description: string };

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
  /** Optional last-used metadata. Updates the head of family in the same
   *  transaction that marks the presented row used; rotation children stay
   *  light. */
  metadata?: DeviceMetadata;
}): Promise<TokenPair> {
  const { refreshToken, clientId, metadata } = params;
  const tokenHash = hashRefreshToken(refreshToken);

  // Two-phase rotation — same split as `exchangeDeviceCodeForTokens`:
  // validate + mark-used in one transaction, mint JWT OUTSIDE, then
  // persist the new refresh token in a second transaction. The mint
  // step goes through Better Auth's `signJWT` API which reads the
  // `jwks` table via the BA adapter; nesting that read inside our
  // Drizzle transaction deadlocks on PGlite's single-connection
  // embedded mode (PostgreSQL pools avoid this because BA gets its
  // own connection). See `exchangeDeviceCodeForTokens` for the full
  // rationale.
  type ValidateOutcome =
    | {
        kind: "ok";
        user: { id: string; email: string; name: string | null; emailVerified: boolean };
        scope: string;
        parentId: string;
        familyId: string;
      }
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

  const validateOutcome: ValidateOutcome = await db.transaction(async (tx) => {
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

    // Mark-before-mint ordering: marking `used_at` here (inside the
    // validate tx) means a crash BEFORE we persist the child row will
    // still trip the reuse branch on retry and revoke the family.
    // Safe failure — no duplicated-usable state.
    await tx
      .update(cliRefreshToken)
      .set({ usedAt: new Date() })
      .where(eq(cliRefreshToken.id, row.id));

    // Bump last-used metadata on the family head (`parent_id IS NULL`).
    // Activity attribution lives on the head row so the listing UI can
    // join children to the head by `family_id` and surface a single
    // "last used" timestamp per device, regardless of how many rotations
    // have occurred. The UPDATE is scoped by `family_id` AND
    // `parent_id IS NULL` so we never accidentally write metadata onto a
    // rotation row even if the head was somehow deleted or revoked.
    const lastUsedAt = new Date();
    const lastUsedIp = metadata?.ip ?? null;
    await tx
      .update(cliRefreshToken)
      .set({ lastUsedAt, lastUsedIp })
      .where(and(eq(cliRefreshToken.familyId, row.familyId), isNull(cliRefreshToken.parentId)));

    const [clientRow] = await tx
      .select({ scopes: oauthClient.scopes })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, clientId))
      .limit(1);
    const narrowedScope = narrowScopeToClient(row.scope ?? "", clientRow?.scopes ?? null, {
      clientId,
      userId: userRow.id,
      phase: "refresh_token",
    });

    return {
      kind: "ok",
      user: userRow,
      scope: narrowedScope,
      parentId: row.id,
      familyId: row.familyId,
    };
  });

  if (validateOutcome.kind === "error") {
    throw new CliTokenError(validateOutcome.code, validateOutcome.description);
  }
  if (validateOutcome.kind === "reuse") {
    // Reuse detected — revoke the whole family in a fresh transaction
    // so the revoke commit is independent of the validate tx. Because
    // the parent-row lock above serialized us with any concurrent
    // winner, their child row (if any) is already committed and
    // visible to this sweep → the `family_id` UPDATE covers it.
    await revokeFamily(validateOutcome.familyId, "reuse");
    logger.warn("oidc: CLI refresh-token reuse detected — family revoked", {
      module: "oidc",
      audit: true,
      event: "cli.refresh_token.reuse",
      familyId: validateOutcome.familyId,
      userId: validateOutcome.userId,
      clientId: validateOutcome.clientId,
    });
    throw new CliTokenError("invalid_grant", "Refresh token has been revoked.");
  }

  // Happy path: validateOutcome.kind === "ok". Mint JWT OUTSIDE any
  // transaction (signJWT goes through BA's adapter), then persist the
  // new child refresh token in a separate transaction.
  const { user, scope, parentId, familyId } = validateOutcome;
  const accessToken = await mintAccessJwt({
    userId: user.id,
    email: user.email,
    name: user.name ?? user.email,
    emailVerified: user.emailVerified === true,
    scope,
    clientId,
    cliFamilyId: familyId,
  });
  const { refreshPlain, selfRevoked } = await db.transaction(async (tx) => {
    const persisted = await persistRefreshTokenInTx(tx, {
      userId: user.id,
      clientId,
      scope,
      parentId,
      familyId,
    });
    // Concurrent-reuse defense: a racing rotation on the same parent
    // token may have revoked the family AFTER our validate-tx committed
    // but BEFORE this persist-tx ran. The family `revoked_at` UPDATE
    // would have missed our freshly-inserted child because the INSERT
    // hadn't happened yet. Catch the race here by checking the family's
    // revoke state inside the persist-tx: if ANY sibling row is already
    // revoked with reason `reuse`, sweep the family again so our child
    // is marked too. This preserves the RFC 6819 §5.2.2.3 invariant
    // that a detected reuse revokes the ENTIRE family, not just the
    // pre-rotation lineage.
    const revokedSibling = await tx
      .select({ reason: cliRefreshToken.revokedReason })
      .from(cliRefreshToken)
      .where(and(eq(cliRefreshToken.familyId, familyId), isNotNull(cliRefreshToken.revokedAt)))
      .limit(1);
    if (revokedSibling.length > 0) {
      await tx
        .update(cliRefreshToken)
        .set({
          revokedAt: new Date(),
          revokedReason: revokedSibling[0]!.reason ?? "reuse",
        })
        .where(and(eq(cliRefreshToken.familyId, familyId), isNull(cliRefreshToken.revokedAt)));
      return { refreshPlain: persisted.refreshPlain, selfRevoked: true };
    }
    return { refreshPlain: persisted.refreshPlain, selfRevoked: false };
  });
  if (selfRevoked) {
    throw new CliTokenError("invalid_grant", "Refresh token has been revoked.");
  }
  return tokenPairResponse(accessToken, refreshPlain, scope);
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

/**
 * Active device session shape returned to the dashboard. Each entry maps
 * to one `family_id` (= one device's lifetime), surfacing only the head
 * row's metadata. Rotation children are intentionally hidden — exposing
 * them would let an observer enumerate the rotation history of a session,
 * leaking activity-pattern information unrelated to "is this device
 * currently active and what was it called when it logged in?".
 *
 * `current` is omitted (always `false`) for callers that don't present a
 * refresh token — the dashboard SPA has no way to identify "this very
 * session" because BA cookie sessions are orthogonal to refresh-token
 * families. The CLI, when it ever reuses this endpoint, can populate it.
 */
export interface CliSessionListEntry {
  familyId: string;
  deviceName: string | null;
  userAgent: string | null;
  createdIp: string | null;
  lastUsedIp: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
  current: boolean;
}

/**
 * List a user's active CLI sessions. "Active" = head of family
 * (`parent_id IS NULL`) AND not revoked AND not expired. Yields one entry
 * per device the user is currently signed into.
 *
 * Sort order: most recent activity first, falling back to creation time
 * for sessions that have never rotated. This puts the device that was
 * "actually used last" at the top — what users typically want to see in
 * a session list.
 */
export async function listSessionsForUser(userId: string): Promise<CliSessionListEntry[]> {
  const now = new Date();
  const rows = await db
    .select({
      familyId: cliRefreshToken.familyId,
      deviceName: cliRefreshToken.deviceName,
      userAgent: cliRefreshToken.userAgent,
      createdIp: cliRefreshToken.createdIp,
      lastUsedIp: cliRefreshToken.lastUsedIp,
      lastUsedAt: cliRefreshToken.lastUsedAt,
      createdAt: cliRefreshToken.createdAt,
      expiresAt: cliRefreshToken.expiresAt,
    })
    .from(cliRefreshToken)
    .where(
      and(
        eq(cliRefreshToken.userId, userId),
        isNull(cliRefreshToken.parentId),
        isNull(cliRefreshToken.revokedAt),
      ),
    );
  return rows
    .filter((r) => r.expiresAt > now)
    .map((r) => ({
      familyId: r.familyId,
      deviceName: r.deviceName,
      userAgent: r.userAgent,
      createdIp: r.createdIp,
      lastUsedIp: r.lastUsedIp,
      lastUsedAt: r.lastUsedAt,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      current: false,
    }))
    .sort((a, b) => {
      const aTs = (a.lastUsedAt ?? a.createdAt).getTime();
      const bTs = (b.lastUsedAt ?? b.createdAt).getTime();
      return bTs - aTs;
    });
}

/**
 * Revoke a single CLI session family on behalf of its owner. The ownership
 * check (`userId === head.userId`) is the only authorization gate — the
 * caller is expected to have already authenticated as `userId` (cookie
 * session in the dashboard, or platform auth in the CLI).
 *
 * Returns `false` when the family doesn't exist, doesn't belong to
 * `userId`, or is already fully revoked. The caller maps this to either
 * 404 (genuinely unknown / not yours) or 200-no-op (already revoked) at
 * its discretion — surface the boolean and let the route layer decide.
 *
 * Reason `user_revoked` is distinct from `logout` (set by the
 * RFC 7009 self-revoke path) and `reuse` (set by the security-event
 * branch in `rotateRefreshToken`). The audit log can therefore separate
 * "user actively signed device out from the dashboard" from "CLI sent
 * its own revoke" from "potential token theft".
 */
export async function revokeFamilyForUser(params: {
  userId: string;
  familyId: string;
}): Promise<boolean> {
  const { userId, familyId } = params;
  const [head] = await db
    .select({
      userId: cliRefreshToken.userId,
      revokedAt: cliRefreshToken.revokedAt,
    })
    .from(cliRefreshToken)
    .where(and(eq(cliRefreshToken.familyId, familyId), isNull(cliRefreshToken.parentId)))
    .limit(1);
  if (!head || head.userId !== userId) return false;
  if (head.revokedAt) return false;
  await revokeFamily(familyId, "user_revoked");
  return true;
}

/**
 * Revoke every active CLI session family belonging to a user. Server
 * primitive backing `appstrate logout --all` (ADR-006) and the dashboard
 * "Revoke all sessions" button. Idempotent — already-revoked families
 * are skipped at the SQL level.
 *
 * Returns the count of families newly revoked so the caller can render a
 * meaningful confirmation toast ("Signed out 3 devices.").
 *
 * Implementation: a single UPDATE scoped by `user_id` + active
 * (`revoked_at IS NULL`). We don't need to enumerate families first —
 * the rotation children carry the same `revoked_at` column and the same
 * UPDATE flips both heads and children. The audit reason is
 * `user_revoked_all` so it is distinguishable from per-family revocation
 * in the security log.
 */
export async function revokeAllFamiliesForUser(userId: string): Promise<{ revokedCount: number }> {
  // Count families that will be touched BEFORE the UPDATE, so the return
  // value matches "number of devices signed out" rather than "number of
  // rows touched" (rotation rows would inflate the latter into something
  // that doesn't reflect user-visible state).
  const heads = await db
    .select({ familyId: cliRefreshToken.familyId })
    .from(cliRefreshToken)
    .where(
      and(
        eq(cliRefreshToken.userId, userId),
        isNull(cliRefreshToken.parentId),
        isNull(cliRefreshToken.revokedAt),
      ),
    );
  if (heads.length === 0) return { revokedCount: 0 };
  await db
    .update(cliRefreshToken)
    .set({ revokedAt: new Date(), revokedReason: "user_revoked_all" })
    .where(and(eq(cliRefreshToken.userId, userId), isNull(cliRefreshToken.revokedAt)));
  // Drop device-name cache entries for the revoked families — same race
  // window as `revokeFamily` (see comment there). Bulk path bypasses the
  // single-family helper, so invalidate inline.
  for (const { familyId } of heads) _runnerDeviceNameCache.delete(familyId);
  return { revokedCount: heads.length };
}

/**
 * Hot-path check called from `oidcAuthStrategy` on every CLI Bearer
 * authentication. Verifies the family is still active (not revoked, not
 * expired, head row exists for the user), and opportunistically bumps
 * `last_used_at` + `last_used_ip` on the head row when the previous bump
 * is more than `LAST_USED_TOUCH_INTERVAL_MS` old. The throttle keeps the
 * write rate to at most one UPDATE per minute per family even under
 * sustained Bearer traffic, while still surfacing recent activity in the
 * dashboard within ~60 s.
 *
 * Returns `false` when the family has been revoked or no longer matches
 * the user (deleted, transferred, etc.) — the strategy maps this to
 * "auth fails", same as a malformed/expired JWT. Returns `true` for
 * still-active families.
 */
const LAST_USED_TOUCH_INTERVAL_MS = 60 * 1000;

export async function checkFamilyAndTouch(params: {
  familyId: string;
  userId: string;
  ip: string | null;
}): Promise<boolean> {
  const { familyId, userId, ip } = params;
  const [head] = await db
    .select({
      userId: cliRefreshToken.userId,
      revokedAt: cliRefreshToken.revokedAt,
      expiresAt: cliRefreshToken.expiresAt,
      lastUsedAt: cliRefreshToken.lastUsedAt,
      lastUsedIp: cliRefreshToken.lastUsedIp,
    })
    .from(cliRefreshToken)
    .where(and(eq(cliRefreshToken.familyId, familyId), isNull(cliRefreshToken.parentId)))
    .limit(1);
  if (!head) return false;
  if (head.userId !== userId) return false;
  if (head.revokedAt) return false;
  if (head.expiresAt < new Date()) return false;

  const now = Date.now();
  const stale = !head.lastUsedAt || now - head.lastUsedAt.getTime() >= LAST_USED_TOUCH_INTERVAL_MS;
  if (stale) {
    // Best-effort. A failed UPDATE here must not break authentication —
    // log and continue. Concurrent writers landing in the same window
    // produce a small redundant write at worst.
    try {
      await db
        .update(cliRefreshToken)
        .set({
          lastUsedAt: new Date(now),
          lastUsedIp: ip ?? head.lastUsedIp,
        })
        .where(and(eq(cliRefreshToken.familyId, familyId), isNull(cliRefreshToken.parentId)));
    } catch (err) {
      logger.warn("oidc: cli last_used_at bump failed — auth still allowed", {
        module: "oidc",
        familyId,
        error: getErrorMessage(err),
      });
    }
  }
  return true;
}

/**
 * Module-owned lookup consumed by the platform's runner-name resolver
 * (`apps/api/src/lib/runner-context.ts`). Returns the device name
 * recorded on a CLI session's head row, used as the human-friendly label
 * stamped on `runs.runner_name` at run-creation time when the caller
 * authenticated via a CLI JWT and didn't override via
 * `X-Appstrate-Runner-Name`.
 *
 * Cached in-memory (TTL 60 s) — runner-name resolution sits on the
 * run-creation hot path and the underlying row barely ever changes
 * (device names are stamped at login and never re-captured on rotation).
 * A short TTL also bounds the staleness window after a manual rename
 * via the dashboard.
 */
const RUNNER_DEVICE_NAME_CACHE_TTL_MS = 60 * 1000;
/** Coarse upper bound on the cache. The 60 s TTL means dead keys naturally
 *  expire on read, but `Map.delete` is never called on a TTL miss — so a
 *  stream of distinct family ids would grow the Map unbounded between
 *  reads of the same key. At ~10 k entries (~1 MB at typical key+name
 *  sizes) we wholesale-clear and let the cache rebuild from cold. Cheaper
 *  than maintaining LRU bookkeeping for a path whose miss is one indexed
 *  query. */
const RUNNER_DEVICE_NAME_CACHE_MAX_ENTRIES = 10_000;
const _runnerDeviceNameCache = new Map<string, { name: string | null; expiresAt: number }>();

export async function lookupCliDeviceName(familyId: string): Promise<string | null> {
  const now = Date.now();
  const cached = _runnerDeviceNameCache.get(familyId);
  if (cached && cached.expiresAt > now) return cached.name;
  try {
    const [row] = await db
      .select({ deviceName: cliRefreshToken.deviceName })
      .from(cliRefreshToken)
      .where(and(eq(cliRefreshToken.familyId, familyId), isNull(cliRefreshToken.parentId)))
      .limit(1);
    const name = row?.deviceName ?? null;
    if (_runnerDeviceNameCache.size >= RUNNER_DEVICE_NAME_CACHE_MAX_ENTRIES) {
      _runnerDeviceNameCache.clear();
    }
    _runnerDeviceNameCache.set(familyId, {
      name,
      expiresAt: now + RUNNER_DEVICE_NAME_CACHE_TTL_MS,
    });
    return name;
  } catch (err) {
    logger.warn("oidc: cli device-name lookup failed (runner attribution)", {
      module: "oidc",
      familyId,
      error: getErrorMessage(err),
    });
    return null;
  }
}

/**
 * Test-only — drop the device-name cache between fixtures so stale
 * entries from one test don't bleed into the next.
 */
export function _resetRunnerDeviceNameCacheForTesting(): void {
  _runnerDeviceNameCache.clear();
}

// ─── Phase 3: admin org-scoped oversight (#251) ─────────────────────────────

/**
 * Admin-facing variant of {@link CliSessionListEntry}. Carries the
 * owning member's identity in addition to the session metadata so the
 * Members tab can render "X's MacBook · last used 3 min ago" without
 * the dashboard performing a second per-row lookup.
 */
export interface AdminCliSessionListEntry extends CliSessionListEntry {
  userId: string;
  userEmail: string | null;
  userName: string | null;
}

/**
 * List every active CLI session held by a member of `orgId`. Admin/owner
 * route visibility — gated by the route layer, not this service.
 *
 * Implementation: join `cli_refresh_tokens` heads to `org_members`, then
 * left-join to `user` for name/email enrichment. Rows are scoped to the
 * org's roster the moment the query runs — a member who left the org
 * yesterday no longer appears here, even though their head row remains
 * present (cascade is on `user`, not `org_members`).
 *
 * The shape MIRRORS the user-facing list rather than diverging into a
 * new contract — admins get the same per-device columns plus owner
 * identity, so the Members tab can reuse the icon/UA-categorization
 * helpers built for the personal Devices page.
 */
export async function listSessionsForOrg(orgId: string): Promise<AdminCliSessionListEntry[]> {
  const now = new Date();
  const rows = await db
    .select({
      familyId: cliRefreshToken.familyId,
      deviceName: cliRefreshToken.deviceName,
      userAgent: cliRefreshToken.userAgent,
      createdIp: cliRefreshToken.createdIp,
      lastUsedIp: cliRefreshToken.lastUsedIp,
      lastUsedAt: cliRefreshToken.lastUsedAt,
      createdAt: cliRefreshToken.createdAt,
      expiresAt: cliRefreshToken.expiresAt,
      userId: cliRefreshToken.userId,
      userEmail: userTable.email,
      userName: userTable.name,
    })
    .from(cliRefreshToken)
    .innerJoin(organizationMembers, eq(organizationMembers.userId, cliRefreshToken.userId))
    .leftJoin(userTable, eq(userTable.id, cliRefreshToken.userId))
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        isNull(cliRefreshToken.parentId),
        isNull(cliRefreshToken.revokedAt),
      ),
    );
  return rows
    .filter((r) => r.expiresAt > now)
    .map((r) => ({
      familyId: r.familyId,
      deviceName: r.deviceName,
      userAgent: r.userAgent,
      createdIp: r.createdIp,
      lastUsedIp: r.lastUsedIp,
      lastUsedAt: r.lastUsedAt,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      current: false,
      userId: r.userId,
      userEmail: r.userEmail,
      userName: r.userName,
    }))
    .sort((a, b) => {
      const aTs = (a.lastUsedAt ?? a.createdAt).getTime();
      const bTs = (b.lastUsedAt ?? b.createdAt).getTime();
      return bTs - aTs;
    });
}

/**
 * Revoke a CLI session on behalf of an org admin. The family must belong
 * to a CURRENT member of `orgId` — a session whose owner has since left
 * the org is invisible to admins of that org and cannot be revoked
 * through this surface (the user themselves still can via the Phase 2
 * personal endpoints).
 *
 * Returns `false` when the family is unknown, doesn't belong to a member
 * of `orgId`, or is already fully revoked. Reason `org_admin_revoked` is
 * distinct from the personal `user_revoked` so the audit log can
 * separate "the user signed their own device out" from "an org admin
 * forced a member's device out".
 *
 * The two-query shape (lookup head → revoke family) is deliberate: a
 * single UPDATE with the membership join would silently skip the
 * "already revoked" case without surfacing it to the caller, and we
 * want the boolean discriminator for the route layer.
 */
export async function revokeFamilyForOrgAdmin(params: {
  orgId: string;
  familyId: string;
}): Promise<boolean> {
  const { orgId, familyId } = params;
  const [head] = await db
    .select({
      userId: cliRefreshToken.userId,
      revokedAt: cliRefreshToken.revokedAt,
    })
    .from(cliRefreshToken)
    .innerJoin(organizationMembers, eq(organizationMembers.userId, cliRefreshToken.userId))
    .where(
      and(
        eq(cliRefreshToken.familyId, familyId),
        isNull(cliRefreshToken.parentId),
        eq(organizationMembers.orgId, orgId),
      ),
    )
    .limit(1);
  if (!head) return false;
  if (head.revokedAt) return false;
  await revokeFamily(familyId, "org_admin_revoked");
  return true;
}

/**
 * Test-only export — covers a regression around membership scoping.
 * Production callers always go through {@link listSessionsForOrg} or
 * {@link revokeFamilyForOrgAdmin}.
 */
export async function _orgMembersUserIdsForTesting(orgId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(inArray(organizationMembers.orgId, [orgId]));
  return rows.map((r) => r.userId);
}

async function revokeFamily(familyId: string, reason: string): Promise<void> {
  await db
    .update(cliRefreshToken)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(cliRefreshToken.familyId, familyId), isNull(cliRefreshToken.revokedAt)));
  // Drop the device-name cache entry so a run created in the next 60 s
  // doesn't stamp the dead session's label on `runs.runner_name`. The
  // strategy already rejects bearers from a revoked family, but a request
  // admitted just before the revocation can still reach run creation.
  _runnerDeviceNameCache.delete(familyId);
}

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Persist a refresh-token row inside a caller-supplied Drizzle transaction.
 * The caller mints the access JWT BEFORE opening the transaction (JWT
 * signing goes through Better Auth's `jwt()` plugin which uses its own
 * adapter path — nesting that inside a PGlite transaction deadlocks on
 * single-connection embedded mode). Returns the plaintext refresh token;
 * the hash is persisted to the DB.
 */
async function persistRefreshTokenInTx(
  tx: DbOrTx,
  params: {
    userId: string;
    clientId: string;
    scope: string;
    parentId: string | null;
    familyId: string;
    /** Only honored on the head of family (`parentId === null`). Rotation
     *  children always store `null` for the metadata columns. */
    metadata?: DeviceMetadata;
  },
): Promise<{ refreshPlain: string }> {
  const { userId, clientId, scope, parentId, familyId, metadata } = params;
  const refreshPlain = generateRefreshToken();
  const refreshHash = hashRefreshToken(refreshPlain);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
  const isHead = parentId === null;
  await tx.insert(cliRefreshToken).values({
    id: prefixedId("crf"),
    tokenHash: refreshHash,
    userId,
    clientId,
    familyId,
    parentId,
    scope,
    expiresAt,
    createdAt: new Date(),
    usedAt: null,
    revokedAt: null,
    revokedReason: null,
    deviceName: isHead ? (metadata?.deviceName ?? null) : null,
    userAgent: isHead ? (metadata?.userAgent ?? null) : null,
    createdIp: isHead ? (metadata?.ip ?? null) : null,
    lastUsedIp: null,
    lastUsedAt: null,
  });
  return { refreshPlain };
}

function tokenPairResponse(accessToken: string, refreshPlain: string, scope: string): TokenPair {
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
  /** CLI refresh-token family id this access token belongs to. Stamped on
   *  the JWT so the OIDC strategy can reject tokens whose family has been
   *  revoked, without waiting for the next refresh. */
  cliFamilyId: string;
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
    // Custom claim — read by `oidcAuthStrategy.resolveInstanceUser` to
    // gate the token on the family's revocation state. Absent on
    // non-CLI instance tokens (e.g. satellite admin app `/oauth2/token`),
    // which the strategy treats as "no family check applies".
    cli_family_id: claims.cliFamilyId,
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
  ctx: { clientId: string; userId: string; phase?: "device_code" | "refresh_token" },
): string {
  const tokens = requested.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  // Audit event discriminates where the drop fired — at the initial
  // device-code exchange (possible crafted `/device/code` request) or
  // at a later refresh-token rotation (operator narrowed the client's
  // scopes after a grant was issued).
  const phase = ctx.phase ?? "device_code";
  const event = `cli.${phase}.scope.dropped`;
  // Absence of a declared scope set is surprising for any client that
  // has made it through `/device/code` — BA's plugin writes the scope
  // string as-posted. Fail closed (empty scope) and audit, rather than
  // echoing an un-gated `scope` claim into the JWT.
  if (!clientScopes || clientScopes.length === 0) {
    logger.warn(`oidc: CLI ${phase} — client has no declared scopes, dropping all`, {
      module: "oidc",
      audit: true,
      event,
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
    logger.warn(`oidc: CLI ${phase} — dropped scope tokens not declared on client`, {
      module: "oidc",
      audit: true,
      event,
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
