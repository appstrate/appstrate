// SPDX-License-Identifier: Apache-2.0

/**
 * Test Redis helpers.
 *
 * In tier3 (REDIS_URL set) these talk to a real Redis. In tier0 (no REDIS_URL,
 * see test/setup/preload.ts) the platform runs on the in-memory infra adapters,
 * so `flushRedis()` resets that in-memory state instead of issuing FLUSHALL,
 * and `getRedis()` throws — tests that genuinely need a real Redis are skipped
 * via the tier0 guards in `./tier.ts`.
 */
import Redis from "ioredis";
import { getEnv } from "@appstrate/env";

let redis: Redis | null = null;

/** True when a real Redis is configured (tier2+). */
function hasRedis(): boolean {
  return !!getEnv().REDIS_URL;
}

function getRedis(): Redis {
  if (!redis) {
    const url = getEnv().REDIS_URL;
    if (!url) throw new Error("REDIS_URL is required for Redis tests");
    redis = new Redis(url, { maxRetriesPerRequest: null });
  }
  return redis;
}

/**
 * Reset all rate-limit + cache state between tests.
 *
 * tier3: FLUSHALL on the real Redis.
 * tier0: reset the rate-limiter middleware cache (fresh RateLimiterMemory
 *        instances) and tear down the in-memory infra singletons (clears the
 *        LocalCache map used for idempotency) so the next access recreates
 *        empty adapters — the in-memory equivalent of FLUSHALL.
 *
 * Better Auth's own limiter rides the same factory under the `rl:better-auth:`
 * prefix, so FLUSHALL already covers it; tier0 needs its limiter cache dropped
 * alongside the middleware's. The Better Auth budget alone is reset after every
 * test by the global `afterEach` in `test/setup/preload.ts` — a file calls this
 * for the rest of the state.
 *
 * Call in beforeEach() when testing rate-limit / idempotency / cache features.
 */
export async function flushRedis(): Promise<void> {
  if (hasRedis()) {
    await getRedis().flushall();
    return;
  }
  const { resetRateLimiters } = await import("../../src/middleware/rate-limit.ts");
  const { resetBetterAuthRateLimitStorage } =
    await import("../../src/infra/rate-limit/better-auth-storage.ts");
  const { shutdownInfra } = await import("../../src/infra/index.ts");
  resetRateLimiters();
  resetBetterAuthRateLimitStorage();
  await shutdownInfra();
}

/**
 * Drop every Better Auth rate-limit bucket. The suite runs in one process
 * behind one address and the built-in `/sign-in*` rule is 3 per 10 s per
 * address, so `test/setup/preload.ts` calls this after every test.
 *
 * tier0: the buckets live inside the cached limiter objects — dropping them is
 *        the whole reset.
 * tier3: the keys outlive those objects; they are swept by prefix through the
 *        platform's own shared client (no second connection to keep the process
 *        alive), and only when something was consumed since the last reset and
 *        that client is still live.
 */
export async function resetBetterAuthRateLimitBuckets(): Promise<void> {
  const { resetBetterAuthRateLimitStorage, BETTER_AUTH_RATE_LIMIT_KEY_PREFIX } =
    await import("../../src/infra/rate-limit/better-auth-storage.ts");
  const consumed = resetBetterAuthRateLimitStorage();
  if (!consumed || !hasRedis()) return;
  const { getRedisConnection, hasRedisConnection } = await import("../../src/lib/redis.ts");
  // The limiter storage writes through this same shared client, so with none
  // live nothing has been consumed through it since the close.
  if (!hasRedisConnection()) return;
  const redis = getRedisConnection();
  try {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        `${BETTER_AUTH_RATE_LIMIT_KEY_PREFIX}*`,
        "COUNT",
        1000,
      );
      if (keys.length > 0) await redis.unlink(...keys);
      cursor = next;
    } while (cursor !== "0");
  } catch (err) {
    throw new Error(
      `resetBetterAuthRateLimitBuckets: sweeping ${BETTER_AUTH_RATE_LIMIT_KEY_PREFIX}* failed`,
      { cause: err },
    );
  }
}

/** Close Redis connection. Call in afterAll() of test suites that use Redis. No-op in tier0. */
export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
