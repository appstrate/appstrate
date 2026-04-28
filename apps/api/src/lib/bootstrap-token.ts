// SPDX-License-Identifier: Apache-2.0

/**
 * `AUTH_BOOTSTRAP_TOKEN` lifecycle (issue #344 Layer 2b).
 *
 * The CLI writes a one-shot redemption token to `.env` when an unattended
 * install lands without a named owner email. The platform reads it at
 * boot, holds it in process memory, and lets the FIRST POST to
 * `/api/auth/bootstrap/redeem` matching that token claim ownership of
 * the instance — closing the historical "silent open mode after
 * curl|bash" footgun.
 *
 * State semantics:
 *   - **Configured**     — `env.AUTH_BOOTSTRAP_TOKEN.length > 0`.
 *   - **Pending**        — configured AND not yet consumed in this process AND
 *                          no organizations exist in the DB. The DB check
 *                          makes the consumed state durable across restarts:
 *                          once any org has been created, the token cannot be
 *                          replayed even if the operator forgets to remove it
 *                          from `.env`.
 *   - **Consumed**       — flipped in-memory after a successful redemption.
 *                          Idempotent — a second concurrent attempt sees
 *                          either the in-memory flag or the now-existing org.
 *
 * The token VALUE is never exposed to clients. Only the boolean state
 * (`bootstrapTokenPending` on AppConfig) is surfaced; redemption requires
 * the operator to paste the exact token, which they retrieve from the
 * install banner or from `<dir>/.env` via SSH.
 */

import { timingSafeEqual } from "node:crypto";
import { count } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { organizations } from "@appstrate/db/schema";
import { getEnv } from "@appstrate/env";
import { createLogger } from "@appstrate/core/logger";

const logger = createLogger("info");

let _consumed = false;

/** True when an `AUTH_BOOTSTRAP_TOKEN` value is set in env (regardless of pending state). */
export function isBootstrapTokenConfigured(): boolean {
  return getEnv().AUTH_BOOTSTRAP_TOKEN.length > 0;
}

/**
 * Synchronous best-effort pending check. Returns false the moment the
 * in-memory consume flag flips, but does NOT consult the DB — used by
 * `buildAppConfig()` which runs once at boot, well before the first
 * organization could plausibly exist on a fresh install.
 *
 * For request-time gating (the redeem route) prefer the async
 * `isBootstrapTokenRedeemable()` which adds the durable DB check.
 */
export function isBootstrapTokenPending(): boolean {
  return !_consumed && isBootstrapTokenConfigured();
}

/**
 * Authoritative pending check: combines the in-memory consume flag with
 * a row count on `organizations`. The DB read makes the redeem path
 * idempotent across process restarts — once any org exists, the token
 * is dead even if the operator forgets to clear `.env`.
 *
 * Index-covered single-row count, ~0.1ms even on a populated instance.
 */
export async function isBootstrapTokenRedeemable(): Promise<boolean> {
  if (!isBootstrapTokenPending()) return false;
  const [row] = await db.select({ n: count() }).from(organizations);
  return (row?.n ?? 0) === 0;
}

/**
 * Constant-time compare of `submitted` against `env.AUTH_BOOTSTRAP_TOKEN`.
 * Returns false on length mismatch (after running a dummy compare to
 * keep the timing profile uniform across the bad-shape and bad-bytes
 * branches).
 */
export function verifyBootstrapToken(submitted: string): boolean {
  const expected = getEnv().AUTH_BOOTSTRAP_TOKEN;
  if (!expected) return false;
  const a = Buffer.from(submitted, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Burn the same constant-time op against a known-equal pair so the
    // length-mismatch branch doesn't return measurably faster than the
    // length-equal-but-bytes-differ branch. Same trick as Better Auth's
    // session-token verifier.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Mark the token consumed for the rest of this process lifetime. Idempotent. */
export function markBootstrapTokenConsumed(): void {
  if (_consumed) return;
  _consumed = true;
  logger.info("bootstrap-token: consumed");
}

/** Test-only: reset the in-memory consume flag. Production callers must NOT use this. */
export function _resetBootstrapTokenForTesting(): void {
  _consumed = false;
}
