// SPDX-License-Identifier: Apache-2.0

/**
 * Distributed mutual exclusion over Redis — serializes a critical section
 * across API instances behind a load balancer.
 *
 * Used by the OAuth refresh paths (model-provider + integration connections):
 * IdPs that rotate `refresh_token` on use (Google, Okta, Auth0, OpenAI,
 * Anthropic) make a concurrent cross-instance refresh dangerous — the slow
 * caller POSTs an already-consumed refresh token, gets `invalid_grant`, and
 * would otherwise flag a perfectly valid connection as revoked. Holding this
 * lock (plus a re-read of the stored credential after acquisition) collapses
 * those concurrent refreshes to one upstream exchange.
 *
 * On Tier 0/1 (no Redis) the platform is single-instance by definition, and
 * `dedupedRefresh` already serializes every flight for one credential in
 * process (per-key chain, not just the singleflight map), so the lock adds
 * nothing and is skipped.
 */

import { hasRedis } from "../infra/mode.ts";
import { getRedisConnection } from "./redis.ts";
import { logger } from "./logger.ts";
import { randomBytes } from "node:crypto";

/**
 * Lua for safe release: only DEL when the value still matches the lock-id we
 * wrote, so we never delete a lock another instance acquired after our TTL.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

/**
 * Lua for safe renewal: only push the expiry out while the value is still our
 * lock-id. A holder whose lease already lapsed must NOT resurrect it — the key
 * may belong to the instance that took over.
 */
const RENEW_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`;

/**
 * Renewals per lease. Three gives two consecutive failed renewals of headroom
 * before the lease lapses, which is what makes a Redis hiccup survivable.
 */
const RENEWALS_PER_LEASE = 3;

/**
 * Polling grace past the moment a holder's lease is guaranteed gone
 * (`maxHoldSeconds + ttlSeconds`), so a waiter ACQUIRES the reclaimed lock
 * instead of giving up one poll short of it.
 */
const ACQUIRE_GRACE_MS = 5_000;

interface RedisLockOptions {
  /**
   * Lease length. Renewed by a watchdog while `fn` runs, so this is not a cap
   * on the critical section — it is how long a CRASHED holder's lock lingers
   * before another instance can reclaim it.
   */
  ttlSeconds: number;
  /**
   * Hard cap on how long the watchdog keeps renewing. Past it the holder is
   * not slow, it is wedged: renewal stops and the lease lapses within
   * `ttlSeconds`, so a hung `fn` can never own the key forever. Sized by the
   * caller from its critical section's worst legitimate duration.
   */
  maxHoldSeconds: number;
  /** Optional label for the lock's log lines. */
  label?: string;
}

/**
 * Keep the lease alive while the critical section runs.
 *
 * Without this, a section that outlives `ttlSeconds` — an upstream exchange
 * plus a DB read under pressure — silently loses its lock to a waiter and the
 * two run concurrently, which for a rotating `refresh_token` means both spend
 * it and the loser writes a dead one.
 *
 * Renewal is capped (`maxHoldSeconds`) rather than unbounded: a hung holder
 * renewing forever would deadlock the key for every other instance.
 *
 * Returns the stop function; calling it is mandatory (the `finally` below).
 */
function startLeaseWatchdog(
  renew: () => Promise<boolean>,
  opts: RedisLockOptions & { onLapse: (reason: string) => void },
): () => void {
  const intervalMs = Math.max(1, Math.floor((opts.ttlSeconds * 1_000) / RENEWALS_PER_LEASE));
  const stopRenewingAt = Date.now() + opts.maxHoldSeconds * 1_000;
  let stopped = false;
  let timer = setTimeout(runTick, intervalMs);

  /** `setTimeout` wants a void callback; the tick is async and self-scheduling. */
  function runTick(): void {
    void tick();
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    if (Date.now() >= stopRenewingAt) {
      opts.onLapse("max hold reached");
      return;
    }
    let held = true;
    try {
      held = await renew();
    } catch (err) {
      // Transient Redis failure: keep trying — two more renewals fit inside
      // the remaining lease.
      logger.warn("distributed lock renewal failed", {
        key: opts.label,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!held) {
      opts.onLapse("lease already lost");
      return;
    }
    if (!stopped) timer = setTimeout(runTick, intervalMs);
  }

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/**
 * Run `fn` while holding the Redis lock `key`. When Redis is absent the lock
 * is a no-op and `fn` runs directly.
 *
 * The lease is renewed for as long as `fn` runs, up to `maxHoldSeconds`. A
 * waiter therefore polls until the holder's lease is guaranteed gone
 * (`maxHoldSeconds + ttlSeconds`, i.e. the holder stopped renewing AND the
 * last lease expired) before giving up; giving up any earlier would hand a
 * live holder's critical section a concurrent peer, which is the very thing
 * the lock exists to prevent. Past that point the holder is presumed dead and
 * `fn` runs unlocked with a warning (availability over strict mutual
 * exclusion — the caller's per-key in-process serialization still bounds the
 * blast radius).
 */
export async function withRedisLock<T>(
  key: string,
  opts: RedisLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  if (!hasRedis()) return fn();

  const redis = getRedisConnection();
  const lockId = randomBytes(16).toString("hex");
  const deadline = Date.now() + (opts.maxHoldSeconds + opts.ttlSeconds) * 1_000 + ACQUIRE_GRACE_MS;
  let acquired = false;

  while (Date.now() < deadline) {
    if ((await redis.set(key, lockId, "EX", opts.ttlSeconds, "NX")) === "OK") {
      acquired = true;
      break;
    }
    // The lock-winner is talking to upstream (~hundreds of ms); poll at 100ms
    // to keep tail latency reasonable without hammering Redis.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!acquired) {
    logger.warn("distributed lock acquisition timed out, proceeding unlocked", {
      key: opts.label ?? key,
    });
    return fn();
  }

  const stopWatchdog = startLeaseWatchdog(
    async () =>
      (await redis.eval(RENEW_LOCK_SCRIPT, 1, key, lockId, String(opts.ttlSeconds * 1_000))) === 1,
    {
      ...opts,
      label: opts.label ?? key,
      onLapse: (reason) =>
        logger.warn("distributed lock lease lapsed while the critical section was running", {
          key: opts.label ?? key,
          reason,
        }),
    },
  );

  try {
    return await fn();
  } finally {
    stopWatchdog();
    // Best-effort release. If the EVAL fails (Redis hiccup), the TTL ensures
    // the lock auto-expires within ttlSeconds.
    try {
      await redis.eval(RELEASE_LOCK_SCRIPT, 1, key, lockId);
    } catch (err) {
      logger.warn("distributed lock release failed", {
        key: opts.label ?? key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
