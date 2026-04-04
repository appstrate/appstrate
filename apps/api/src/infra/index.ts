// SPDX-License-Identifier: Apache-2.0

/**
 * Infrastructure adapter factories.
 * Auto-selects Redis or local implementations based on environment.
 */

import { hasRedis } from "./mode.ts";
import type { PubSub } from "./pubsub/interface.ts";
import type { KeyValueCache } from "./cache/interface.ts";
import type { RateLimiterFactory } from "./rate-limit/interface.ts";
import { RedisPubSub } from "./pubsub/redis-pubsub.ts";
import { LocalPubSub } from "./pubsub/local-pubsub.ts";
import { RedisCache } from "./cache/redis-cache.ts";
import { LocalCache } from "./cache/local-cache.ts";
import { RedisRateLimiterFactory } from "./rate-limit/redis-rate-limit.ts";
import { LocalRateLimiterFactory } from "./rate-limit/local-rate-limit.ts";
import { logger } from "../lib/logger.ts";

// Re-exports for convenience
export { hasRedis, hasS3, getExecutionMode } from "./mode.ts";
export type { PubSub } from "./pubsub/interface.ts";
export type { KeyValueCache, CacheSetOptions } from "./cache/interface.ts";
export type { RateLimiterFactory } from "./rate-limit/interface.ts";

// ---------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

let pubsub: PubSub | null = null;
let cache: KeyValueCache | null = null;
let rateLimiterFactory: RateLimiterFactory | null = null;

export function getPubSub(): PubSub {
  if (pubsub) return pubsub;
  pubsub = hasRedis() ? new RedisPubSub() : new LocalPubSub();
  return pubsub;
}

export function getCache(): KeyValueCache {
  if (cache) return cache;
  cache = hasRedis() ? new RedisCache() : new LocalCache();
  return cache;
}

export function getRateLimiterFactory(): RateLimiterFactory {
  if (rateLimiterFactory) return rateLimiterFactory;
  rateLimiterFactory = hasRedis() ? new RedisRateLimiterFactory() : new LocalRateLimiterFactory();
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
