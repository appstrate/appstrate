// SPDX-License-Identifier: Apache-2.0

/**
 * Shared retry primitives for the isolated runtime packages
 * (`afps-runtime` sinks, `runtime-pi` provisioning). One place for the
 * exponential-backoff arithmetic and the "is this HTTP status worth
 * retrying" rule, so the policies can't silently drift between copies.
 *
 * Deliberately NOT adopted by `mcp-transport` (deadline-clamped full
 * jitter interwoven with its abort handling) or the CLI's `api retry`
 * (curl semantics: `Retry-After` honouring, 408 in the retryable set) —
 * those are different, documented policies, not duplicates.
 */

export interface BackoffOptions {
  /** Delay before the second attempt (attempt 1 retry), in ms. */
  baseMs: number;
  /** Upper bound on the exponential term, in ms. */
  capMs: number;
  /**
   * Additive jitter as a fraction of the (capped) exponential delay:
   * `0.25` adds up to +25%. Defaults to 0 (no jitter).
   */
  jitterRatio?: number;
  /** Injectable RNG for deterministic tests. Defaults to `Math.random`. */
  random?: () => number;
}

/**
 * Exponential backoff delay for a 1-based retry `attempt`:
 * `min(baseMs * 2^(attempt-1), capMs)` plus optional additive jitter.
 */
export function computeBackoffDelayMs(attempt: number, opts: BackoffOptions): number {
  const exp = Math.min(opts.baseMs * 2 ** (Math.max(1, attempt) - 1), opts.capMs);
  const jitter = exp * (opts.jitterRatio ?? 0) * (opts.random ?? Math.random)();
  return Math.floor(exp + jitter);
}

/**
 * Transient-failure rule shared by the runtime HTTP paths: 5xx (upstream
 * fault) and 429 (throttled) are retryable; any other status is a
 * deterministic outcome that retrying cannot fix.
 */
export function isRetryableHttpStatus(status: number): boolean {
  return status >= 500 || status === 429;
}
