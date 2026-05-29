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
 * On Tier 0/1 (no Redis) the platform is single-instance by definition, so the
 * caller's in-process singleflight is sufficient and the lock is skipped.
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

export interface RedisLockOptions {
  /** Lock auto-expiry (safety net if the holder crashes without releasing). */
  ttlSeconds: number;
  /** How long to keep polling for the lock before giving up and proceeding unlocked. */
  acquireTimeoutMs: number;
  /** Optional label for the timeout-warning log line. */
  label?: string;
}

/**
 * Run `fn` while holding the Redis lock `key`. When Redis is absent the lock
 * is a no-op and `fn` runs directly. If the lock can't be acquired within
 * `acquireTimeoutMs`, logs a warning and runs `fn` anyway (availability over
 * strict mutual exclusion — the in-process singleflight still bounds the
 * blast radius, and the TTL guarantees the lock can't wedge forever).
 */
export async function withRedisLock<T>(
  key: string,
  opts: RedisLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  if (!hasRedis()) return fn();

  const redis = getRedisConnection();
  const lockId = randomBytes(16).toString("hex");
  const deadline = Date.now() + opts.acquireTimeoutMs;
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

  try {
    return await fn();
  } finally {
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
