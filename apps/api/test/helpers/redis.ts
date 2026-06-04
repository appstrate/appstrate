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

export function getRedis(): Redis {
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
 * Call in beforeEach() when testing rate-limit / idempotency / cache features.
 */
export async function flushRedis(): Promise<void> {
  if (hasRedis()) {
    await getRedis().flushall();
    return;
  }
  const { resetRateLimiters } = await import("../../src/middleware/rate-limit.ts");
  const { shutdownInfra } = await import("../../src/infra/index.ts");
  resetRateLimiters();
  await shutdownInfra();
}

/** Close Redis connection. Call in afterAll() of test suites that use Redis. No-op in tier0. */
export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
