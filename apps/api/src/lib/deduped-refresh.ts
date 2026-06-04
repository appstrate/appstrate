// SPDX-License-Identifier: Apache-2.0

/**
 * Two-layer deduplication scaffold for OAuth token refresh.
 *
 * Both the integration-connection refresh path and the model-provider refresh
 * path guard concurrent refreshes the same way:
 *
 *   1. **In-process singleflight** — a `Map<key, Promise>` collapses callers
 *      WITHIN a single API instance.
 *   2. **Distributed Redis lock** (`withRedisLock`, `ttlSeconds: 45`,
 *      `acquireTimeoutMs: 30_000`) — serializes ACROSS instances so a rotating
 *      `refresh_token` isn't double-spent (which would falsely flag a valid
 *      credential `needsReconnection`). No-op on Tier 0/1 (single instance).
 *   3. **Post-acquire re-read** — after winning the lock, re-read the stored
 *      row; if the token is now fresh enough, return it without burning the
 *      (possibly just-rotated) `refresh_token`.
 *
 * This helper owns the singleflight Map + `withRedisLock` + the re-read
 * short-circuit + `finally` cleanup. Each caller supplies its own row-read +
 * freshness predicate (`reReadFreshness`) and the actual upstream exchange
 * (`doRefresh`) as callbacks, keeping table-specific concerns out of here.
 */

import { withRedisLock } from "./distributed-lock.ts";

/** Distributed-lock TTL in seconds — sized as `30s network timeout` + slack. */
const REFRESH_LOCK_TTL_SECONDS = 45;
/** How long to wait for the distributed lock before proceeding unlocked. */
const REFRESH_LOCK_ACQUIRE_TIMEOUT_MS = 30_000;

export interface DedupedRefreshOptions<T> {
  /** Redis lock key (e.g. `oauth-refresh:${id}` / `intg-refresh:${id}`). */
  lockKey: string;
  /** Label for the lock's timeout-warning log line. */
  lockLabel: string;
  /**
   * Re-read the stored row under the lock and return a fresh-enough value to
   * short-circuit the refresh, or `null` when a real refresh is still needed.
   */
  reReadFreshness: () => Promise<T | null>;
  /** Perform the actual upstream token exchange + write-back. */
  doRefresh: () => Promise<T>;
}

/** Per-key in-flight singleflight map, keyed by the caller's dedup key. */
const inflightRefreshes = new Map<string, Promise<unknown>>();

/**
 * Coalesce a refresh for `key` through the in-process singleflight + the
 * cross-instance Redis lock, with a post-acquire freshness short-circuit.
 *
 * The singleflight map is keyed by `key`; concurrent callers with the same
 * key share the same in-flight promise. The entry is deleted in `finally`.
 */
export function dedupedRefresh<T>(key: string, opts: DedupedRefreshOptions<T>): Promise<T> {
  const cached = inflightRefreshes.get(key) as Promise<T> | undefined;
  if (cached) return cached;

  const promise = withRedisLock(
    opts.lockKey,
    {
      ttlSeconds: REFRESH_LOCK_TTL_SECONDS,
      acquireTimeoutMs: REFRESH_LOCK_ACQUIRE_TIMEOUT_MS,
      label: opts.lockLabel,
    },
    async () => {
      // A peer instance may have refreshed while we waited for the lock. If
      // the stored token is now comfortably unexpired, return it without
      // burning the (possibly just-rotated) refresh_token.
      const fresh = await opts.reReadFreshness();
      if (fresh !== null) return fresh;
      return opts.doRefresh();
    },
  );
  inflightRefreshes.set(key, promise);
  return promise.finally(() => {
    inflightRefreshes.delete(key);
  });
}
