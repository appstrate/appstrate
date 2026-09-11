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

/** Lock lease — the `30s` network timeout plus slack. See {@link withRedisLock}. */
const REFRESH_LOCK_TTL_SECONDS = 45;
/**
 * Hard cap on renewal: two full exchange timeouts past the lease. Trade-off: a
 * caller queued behind a wedged holder waits up to ~2.5 min before proceeding
 * unlocked. Waiting is the cheaper failure — proceeding early double-spends the
 * rotating `refresh_token` and flags a valid credential `needsReconnection`.
 */
const REFRESH_LOCK_MAX_HOLD_SECONDS = 90;

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

/**
 * A flight's value plus WHICH branch produced it. A forced joiner may adopt an
 * in-flight proactive result only when it came from the exchange — see
 * {@link dedupedRefresh}.
 */
interface FlightOutcome<T> {
  value: T;
  /** `true` when {@link DedupedRefreshOptions.doRefresh} minted this value. */
  exchanged: boolean;
}

/** Per-flight-key in-flight singleflight map (`key` / `key:force`). */
const inflightRefreshes = new Map<string, Promise<FlightOutcome<unknown>>>();
/** Tail of the serialization chain per credential `key`, never rejecting. */
const refreshChains = new Map<string, Promise<unknown>>();

/**
 * Coalesce a refresh for `key` through the in-process singleflight + the
 * cross-instance Redis lock, with a post-acquire freshness short-circuit.
 *
 * `force` IS part of the flight key: a flight applies only its originator's
 * verdict, so a forced caller sharing a proactive flight outright would be
 * handed back the very token that just 401'd it — short-circuited on freshness
 * by that flight's post-acquire re-read, with no upstream exchange at all.
 *
 * Flights that DO run concurrently are chained per `key` (`refreshChains`
 * in-process, the Redis lock across instances): the forced/proactive split
 * costs at most one EXTRA exchange, never a concurrent one.
 */
export function dedupedRefresh<T>(key: string, opts: DedupedRefreshOptions<T>): Promise<T> {
  const force = opts.force === true;
  const flightKey = force ? `${key}:force` : key;
  const cached = inflightRefreshes.get(flightKey) as Promise<FlightOutcome<T>> | undefined;
  if (cached) return cached.then((outcome) => outcome.value);

  if (force) {
    // No forced flight to join, but a proactive one may already be exchanging
    // for this credential. Adopt its token if it gets one; on anything else
    // (freshness short-circuit, failure) re-enter with our own flight, which
    // by then heads the chain. Re-entry cannot storm the upstream: the first
    // re-entrant publishes a `key:force` flight the rest collapse into.
    const proactive = inflightRefreshes.get(key) as Promise<FlightOutcome<T>> | undefined;
    if (proactive) {
      return proactive.then(
        (outcome) => (outcome.exchanged ? outcome.value : dedupedRefresh(key, opts)),
        () => dedupedRefresh(key, opts),
      );
    }
  }

  const previous = refreshChains.get(key) ?? Promise.resolve();
  const promise = previous.then(() =>
    withRedisLock(
      opts.lockKey,
      {
        ttlSeconds: REFRESH_LOCK_TTL_SECONDS,
        maxHoldSeconds: REFRESH_LOCK_MAX_HOLD_SECONDS,
        label: opts.lockLabel,
      },
      async (): Promise<FlightOutcome<T>> => {
        // A peer instance may have refreshed while we waited for the lock. If
        // the stored token is now comfortably unexpired, return it without
        // burning the (possibly just-rotated) refresh_token — unless the caller
        // forced this refresh, in which case remaining lifetime says nothing
        // about whether the token still works.
        const fresh = await opts.reReadFreshness({ force });
        if (fresh !== null) return { value: fresh, exchanged: false };
        return { value: await opts.doRefresh(), exchanged: true };
      },
    ),
  );
  // The chain tail swallows rejections: a failed exchange must not cascade
  // into every later refresh of the same credential.
  const tail = promise.catch(() => {});
  inflightRefreshes.set(flightKey, promise);
  refreshChains.set(key, tail);
  return promise
    .finally(() => {
      inflightRefreshes.delete(flightKey);
      if (refreshChains.get(key) === tail) refreshChains.delete(key);
    })
    .then((outcome) => outcome.value);
}
