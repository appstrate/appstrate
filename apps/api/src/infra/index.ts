// SPDX-License-Identifier: Apache-2.0

/**
 * Infrastructure adapter factories.
 * Auto-selects Redis or local implementations based on environment.
 */

import { hasRedis } from "./mode.ts";
import type { PubSub } from "./pubsub/interface.ts";
import type { KeyValueCache } from "./cache/interface.ts";
import type { RateLimiterFactory } from "./rate-limit/interface.ts";
import { LocalPubSub } from "./pubsub/local-pubsub.ts";
import { LocalCache } from "./cache/local-cache.ts";
import { LocalRateLimiterFactory } from "./rate-limit/local-rate-limit.ts";
import { logger } from "../lib/logger.ts";

// Re-exports for convenience
export { hasRedis, hasS3, getExecutionMode } from "./mode.ts";
export type { PubSub } from "./pubsub/interface.ts";
export type { KeyValueCache, CacheSetOptions } from "./cache/interface.ts";
export type { RateLimiterFactory } from "./rate-limit/interface.ts";

// ---------------------------------------------------------------------------
// Singletons — Redis implementations are loaded lazily via dynamic import()
// to avoid connecting to Redis when REDIS_URL is absent.
// Local implementations are imported statically (no side effects).
// ---------------------------------------------------------------------------

let pubsub: PubSub | null = null;
let cache: KeyValueCache | null = null;
let rateLimiterFactory: RateLimiterFactory | null = null;

export async function getPubSub(): Promise<PubSub> {
  if (pubsub) return pubsub;
  if (hasRedis()) {
    const { RedisPubSub } = await import("./pubsub/redis-pubsub.ts");
    pubsub = new RedisPubSub();
  } else {
    pubsub = new LocalPubSub();
  }
  return pubsub;
}

export async function getCache(): Promise<KeyValueCache> {
  if (cache) return cache;
  if (hasRedis()) {
    const { RedisCache } = await import("./cache/redis-cache.ts");
    cache = new RedisCache();
  } else {
    cache = new LocalCache();
  }
  return cache;
}

export async function getRateLimiterFactory(): Promise<RateLimiterFactory> {
  if (rateLimiterFactory) return rateLimiterFactory;
  if (hasRedis()) {
    const { RedisRateLimiterFactory } = await import("./rate-limit/redis-rate-limit.ts");
    rateLimiterFactory = new RedisRateLimiterFactory();
  } else {
    rateLimiterFactory = new LocalRateLimiterFactory();
  }
  return rateLimiterFactory;
}

/** Shutdown all infrastructure adapters. */
export async function shutdownInfra(): Promise<void> {
  await Promise.all([pubsub?.shutdown(), cache?.shutdown()]);
  pubsub = null;
  cache = null;
  rateLimiterFactory = null;
}

/** Log which infrastructure backends are active. */
export function logInfraMode(): void {
  const redis = hasRedis();
  logger.info("Infrastructure mode", {
    queue: redis ? "BullMQ (Redis)" : "local (in-memory)",
    pubsub: redis ? "Redis" : "local (EventEmitter)",
    cache: redis ? "Redis" : "local (in-memory)",
    rateLimit: redis ? "Redis" : "local (in-memory)",
  });
}
