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
 * Step 3's *freshness* half is conditional on {@link DedupedRefreshOptions.force}:
 * a caller recovering from an upstream 401 KNOWS the stored token is bad, and
 * "expires in 50 minutes" is not evidence to the contrary. The re-read itself
 * still happens either way — it is what lets the exchange spend the freshest
 * `refresh_token` rather than double-spending a rotated one.
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
   * Also partitions the singleflight — forced and proactive callers never
   * share a flight, because a flight applies only its originator's verdict.
   * See {@link dedupedRefresh}.
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

/** Per-key in-flight singleflight map, keyed by the caller's dedup key. */
const inflightRefreshes = new Map<string, Promise<unknown>>();

/**
 * Coalesce a refresh for `key` through the in-process singleflight + the
 * cross-instance Redis lock, with a post-acquire freshness short-circuit.
 *
 * Concurrent callers sharing a flight key share the same in-flight promise.
 * The entry is deleted in `finally`.
 *
 * **`force` IS part of the flight key**, and that is the whole point of this
 * helper: a flight carries its originator's `force` verdict all the way to
 * `reReadFreshness`, so joining someone else's flight means inheriting their
 * verdict. Sharing one flight across both kinds put back the exact defect the
 * `force` flag exists to prevent — a forced caller receiving the token that
 * just 401'd it, with no upstream exchange at all:
 *
 *   instance B refreshes and writes a token; instance A's PROACTIVE caller is
 *   meanwhile queued on the Redis lock; A's flight wins the lock, re-reads,
 *   finds the token comfortably unexpired and short-circuits. A FORCED caller
 *   that joined that flight — it holds upstream proof this very token is dead
 *   — is handed it back and told `{status:"refreshed"}`.
 *
 * Narrower than the bug the flag was introduced for (bounded by the lock wait
 * rather than the token's remaining lifetime, and it needs ≥2 instances for
 * the re-read to find anything new), but the same silent-success shape, and a
 * comment claiming otherwise is worth less than no comment.
 *
 * The cost of splitting is one extra upstream exchange in the single case
 * where a forced and a proactive refresh for the same credential overlap: the
 * forced flight queues on the SAME Redis lock (`opts.lockKey` is unchanged),
 * so the two are still serialized across instances — no concurrent double-spend
 * of a rotating `refresh_token` — and the forced flight's own re-read picks up
 * whatever the proactive one just wrote before exchanging against it. Forced
 * callers still collapse with each other, which is the storm that matters:
 * every in-flight sidecar call 401ing at once is one exchange, not N.
 */
export function dedupedRefresh<T>(key: string, opts: DedupedRefreshOptions<T>): Promise<T> {
  const flightKey = opts.force === true ? `${key}:force` : key;
  const cached = inflightRefreshes.get(flightKey) as Promise<T> | undefined;
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
      // burning the (possibly just-rotated) refresh_token — unless the caller
      // forced this refresh, in which case remaining lifetime says nothing
      // about whether the token still works.
      const fresh = await opts.reReadFreshness({ force: opts.force === true });
      if (fresh !== null) return fresh;
      return opts.doRefresh();
    },
  );
  inflightRefreshes.set(flightKey, promise);
  return promise.finally(() => {
    inflightRefreshes.delete(flightKey);
  });
}
