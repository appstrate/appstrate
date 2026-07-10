// SPDX-License-Identifier: Apache-2.0

/**
 * Retry-on-deadlock helper for the test harness (issue #883).
 *
 * `truncateAll()` runs its DELETEs in a single implicit transaction that
 * takes row locks across every table, `organizations` among the last. A
 * previous test's fire-and-forget async work (e.g. `executeAgentInBackground`
 * writing to `runs`/`run_logs`, or `ensureDefaultProfile` from middleware)
 * can still be in flight: its INSERT takes a `KEY SHARE` lock on the parent
 * `organizations` row (FK enforcement) while the truncate transaction wants
 * to delete that same row and already holds locks the background transaction
 * needs next. Postgres breaks the cycle at `deadlock_timeout` (1s) by
 * aborting one side with SQLSTATE 40P01 — which lands on whichever test
 * happened to call `truncateAll()`.
 *
 * The race is a test-harness artifact (unawaited background work), not
 * production behavior, so retrying the aborted cleanup is honest: the
 * background transaction wins the first round, commits or aborts, and the
 * retry runs against a quiesced database.
 *
 * This module is dependency-free on purpose: unit tests exercise the retry
 * loop and SQLSTATE detection without importing the DB client.
 */

/**
 * SQLSTATEs that mark a transient lock/serialization conflict where retrying
 * the statement is expected to succeed:
 * - 40P01 deadlock_detected — the observed failure mode (issue #883)
 * - 40001 serialization_failure — same class, retry-safe by definition
 * - 55P03 lock_not_available — raised instead of 40P01 when a lock_timeout
 *   is configured shorter than deadlock_timeout
 */
const TRANSIENT_LOCK_SQLSTATES: ReadonlySet<string> = new Set(["40P01", "40001", "55P03"]);

/** How deep to walk an error's `cause` chain before giving up. */
const MAX_CAUSE_DEPTH = 5;

/**
 * True when a DB error is a transient lock/serialization conflict (deadlock,
 * serialization failure, lock timeout) that is safe to retry.
 *
 * Matches on the SQLSTATE `code` property and walks the `cause` chain, since
 * Drizzle wraps the driver error in a `DrizzleQueryError` (same pattern as
 * `isInvalidTextRepresentation` in `lib/db-helpers.ts`). Covers both the
 * Tier-0 embedded driver (PGlite) and a real server (postgres.js).
 */
export function isTransientLockError(err: unknown): boolean {
  let current: unknown = err;
  for (
    let depth = 0;
    current !== null && current !== undefined && depth < MAX_CAUSE_DEPTH;
    depth++
  ) {
    if (typeof current !== "object") break;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_LOCK_SQLSTATES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface DeadlockRetryOptions {
  /** Total attempts including the first one. Default 3. */
  maxAttempts?: number;
  /**
   * Delay before retry attempt `attempt` (2-based: called before the 2nd,
   * 3rd, … attempt), in milliseconds. Default grows linearly (50ms, 100ms) —
   * enough for the winning background transaction to finish. Tests inject
   * `() => 0` to keep the suite fast.
   */
  delayMs?: (attempt: number) => number;
  /**
   * Called after a transient failure, before the next attempt. Use it to
   * surface the retry (the deadlock is a real signal worth counting — see
   * issue #883) without failing the test.
   */
  onRetry?: (err: unknown, attempt: number) => void;
}

/**
 * Run `fn`, retrying when it fails with a transient lock error
 * ({@link isTransientLockError}). Any other error — and the last transient
 * one once attempts are exhausted — is rethrown unchanged.
 */
export async function withDeadlockRetry<T>(
  fn: () => Promise<T>,
  options: DeadlockRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be a positive integer, got ${maxAttempts}`);
  }
  const delayMs = options.delayMs ?? ((attempt) => (attempt - 1) * 50);

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !isTransientLockError(err)) throw err;
      options.onRetry?.(err, attempt);
      const delay = delayMs(attempt + 1);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
