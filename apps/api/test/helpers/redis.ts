// SPDX-License-Identifier: Apache-2.0

/**
 * Test Redis helpers.
 *
 * Provides a Redis connection for tests and a flush helper.
 */
import Redis from "ioredis";
import { getEnv } from "@appstrate/env";

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    const url = getEnv().REDIS_URL;
    if (!url) throw new Error("REDIS_URL is required for Redis tests");
    redis = new Redis(url, { maxRetriesPerRequest: null });
  }
  return redis;
}

/** Flush all Redis keys. Call in beforeEach() when testing Redis-dependent features. */
export async function flushRedis(): Promise<void> {
  await getRedis().flushall();
}

/** Close Redis connection. Call in afterAll() of test suites that use Redis. */
export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
