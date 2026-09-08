// SPDX-License-Identifier: Apache-2.0

/**
 * Two-layer deduplication scaffold for OAuth token refresh.
 *
 * Both the integration-connection refresh path and the model-provider refresh
 * path guard concurrent refreshes the same way:
 *
 *   1. **In-process singleflight + per-key serialization** — one
 *      `Map<flightKey, Promise>` collapses callers sharing a flight key, and a
 *      second `Map<key, Promise>` chains every flight for the same credential
 *      so the two flight keys can never exchange concurrently.
 *   2. **Distributed Redis lock** (`withRedisLock`) — serializes ACROSS
 *      instances so a rotating `refresh_token` isn't double-spent (which would
 *      falsely flag a valid credential `needsReconnection`). No-op on Tier 0/1
 *      (single instance, where layer 1 already serializes).
 *   3. **Post-acquire re-read** — after winning the lock, re-read the stored
 *      row; if the token is now fresh enough, return it without burning the
 *      (possibly just-rotated) `refresh_token`.
 *
 * Step 3's *freshness* half is conditional on {@link DedupedRefreshOptions.force}:
 * a caller recovering from an upstream 401 KNOWS the stored token is bad, and
 * "expires in 50 minutes" is not evidence to the contrary. The re-read itself
 * still happens either way — it is what lets the exchange spend the freshest
 * `refresh_token` rather than double-spending a rotated one.
 *
 * This helper owns both Maps + `withRedisLock` + the re-read
 * short-circuit + `finally` cleanup. Each caller supplies its own row-read +
 * freshness predicate (`reReadFreshness`) and the actual upstream exchange
 * (`doRefresh`) as callbacks, keeping table-specific concerns out of here.
 */

import { withRedisLock } from "./distributed-lock.ts";

/** Distributed-lock TTL in seconds — sized as `30s network timeout` + slack. */
const REFRESH_LOCK_TTL_SECONDS = 45;
/**
 * How long to wait for the distributed lock before proceeding unlocked.
 * Derived from the TTL so the two cannot drift apart: a waiter gives up only
 * once the holder's lock has definitively expired (holder presumed dead),
 * never at the holder's worst-case exchange duration. Trade-off: a sidecar
 * caller queued behind a wedged holder waits up to ~50 s before proceeding —
 * and a forced flight chained behind a proactive one pays that twice, once per
 * hop (~50 s acquire + the 30 s exchange timeout in `@appstrate/connect`), so
 * the honest worst case is ≈160 s. Bounded, but not one lock wait.
 */
const REFRESH_LOCK_ACQUIRE_TIMEOUT_MS = REFRESH_LOCK_TTL_SECONDS * 1_000 + 5_000;

interface DedupedRefreshOptions<T> {
  /** Redis lock key (e.g. `oauth-refresh:${id}` / `intg-refresh:${id}`). */
  lockKey: string;
  /** Label for the lock's timeout-warning log line. */
  lockLabel: string;
  /**
   * The caller has POSITIVE evidence the stored token is unusable (it is
   * recovering from an upstream 401), so the freshness short-circuit must not
   * hand that token back. Forwarded to {@link reReadFreshness} rather than
   * skipping the callback: the re-read has a second job (picking up a peer's
   * just-rotated `refresh_token`) that a forced refresh needs even more.
   *
   * Also partitions the singleflight — see {@link dedupedRefresh}.
   */
  force?: boolean;
  /**
   * Re-read the stored row under the lock and return a fresh-enough value to
   * short-circuit the refresh, or `null` when a real refresh is still needed.
   * MUST return `null` when `force` is set — the expiry-based short-circuit is
   * exactly what the caller is overriding — while still performing the read.
   */
  reReadFreshness: (opts: { force: boolean }) => Promise<T | null>;
  /** Perform the actual upstream token exchange + write-back. */
  doRefresh: () => Promise<T>;
}

/** Per-flight-key in-flight singleflight map (`key` / `key:force`). */
const inflightRefreshes = new Map<string, Promise<unknown>>();
/** Tail of the serialization chain per credential `key`, never rejecting. */
const refreshChains = new Map<string, Promise<unknown>>();

/**
 * Coalesce a refresh for `key` through the in-process singleflight + the
 * cross-instance Redis lock, with a post-acquire freshness short-circuit.
 *
 * `force` IS part of the flight key: a flight applies only its originator's
 * verdict, so a forced caller joining a proactive flight would be handed back
 * the very token that just 401'd it — short-circuited on freshness by that
 * flight's post-acquire re-read, with no upstream exchange at all.
 *
 * The resulting forced/proactive pair is chained per `key` (`refreshChains`
 * in-process, the Redis lock across instances), so the split costs one EXTRA
 * exchange when the two overlap, never a concurrent one.
 */
export function dedupedRefresh<T>(key: string, opts: DedupedRefreshOptions<T>): Promise<T> {
  const flightKey = opts.force === true ? `${key}:force` : key;
  const cached = inflightRefreshes.get(flightKey) as Promise<T> | undefined;
  if (cached) return cached;

  const previous = refreshChains.get(key) ?? Promise.resolve();
  const promise = previous.then(() =>
    withRedisLock(
      opts.lockKey,
      {
        ttlSeconds: REFRESH_LOCK_TTL_SECONDS,
        acquireTimeoutMs: REFRESH_LOCK_ACQUIRE_TIMEOUT_MS,
        label: opts.lockLabel,
      },
      async () => {
        // A peer instance may have refreshed while we waited for the lock. If
        // the stored token is now comfortably unexpired, return it without
        // burning the (possibly just-rotated) refresh_token — unless the caller
        // forced this refresh, in which case remaining lifetime says nothing
        // about whether the token still works.
        const fresh = await opts.reReadFreshness({ force: opts.force === true });
        if (fresh !== null) return fresh;
        return opts.doRefresh();
      },
    ),
  );
  // The chain tail swallows rejections: a failed exchange must not cascade
  // into every later refresh of the same credential.
  const tail = promise.catch(() => {});
  inflightRefreshes.set(flightKey, promise);
  refreshChains.set(key, tail);
  return promise.finally(() => {
    inflightRefreshes.delete(flightKey);
    if (refreshChains.get(key) === tail) refreshChains.delete(key);
  });
}
