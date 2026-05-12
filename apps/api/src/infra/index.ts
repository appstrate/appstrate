// SPDX-License-Identifier: Apache-2.0

/**
 * Infrastructure adapter factories.
 * Auto-selects Redis or local implementations based on environment.
 */

import { hasRedis } from "./mode.ts";
import type { PubSub } from "./pubsub/interface.ts";
import type { KeyValueCache } from "./cache/interface.ts";
import type { RateLimiterFactory } from "./rate-limit/interface.ts";
import type { EventBuffer } from "./event-buffer/interface.ts";
import { LocalPubSub } from "./pubsub/local-pubsub.ts";
import { LocalCache } from "./cache/local-cache.ts";
import { LocalRateLimiterFactory } from "./rate-limit/local-rate-limit.ts";
import { LocalEventBuffer } from "./event-buffer/local-event-buffer.ts";
import { logger } from "../lib/logger.ts";

export { hasRedis, hasExternalDb, hasS3, getExecutionMode } from "./mode.ts";

// ---------------------------------------------------------------------------
// Singletons — Redis implementations are loaded lazily via dynamic import()
// to avoid connecting to Redis when REDIS_URL is absent.
// Local implementations are imported statically (no side effects).
// Promise-based locks prevent duplicate instances from concurrent calls.
// ---------------------------------------------------------------------------

let pubsubPromise: Promise<PubSub> | null = null;
let cachePromise: Promise<KeyValueCache> | null = null;
let rateLimiterPromise: Promise<RateLimiterFactory> | null = null;
let eventBufferPromise: Promise<EventBuffer> | null = null;

export function getPubSub(): Promise<PubSub> {
  if (!pubsubPromise) {
    pubsubPromise = (async () => {
      if (hasRedis()) {
        const { RedisPubSub } = await import("./pubsub/redis-pubsub.ts");
        return new RedisPubSub();
      }
      return new LocalPubSub();
    })();
  }
  return pubsubPromise;
}

export function getCache(): Promise<KeyValueCache> {
  if (!cachePromise) {
    cachePromise = (async () => {
      if (hasRedis()) {
        const { RedisCache } = await import("./cache/redis-cache.ts");
        return new RedisCache();
      }
      return new LocalCache();
    })();
  }
  return cachePromise;
}

export function getRateLimiterFactory(): Promise<RateLimiterFactory> {
  if (!rateLimiterPromise) {
    rateLimiterPromise = (async () => {
      if (hasRedis()) {
        const { RedisRateLimiterFactory } = await import("./rate-limit/redis-rate-limit.ts");
        return new RedisRateLimiterFactory();
      }
      return new LocalRateLimiterFactory();
    })();
  }
  return rateLimiterPromise;
}

export function getEventBuffer(): Promise<EventBuffer> {
  if (!eventBufferPromise) {
    eventBufferPromise = (async () => {
      if (hasRedis()) {
        const { RedisEventBuffer } = await import("./event-buffer/redis-event-buffer.ts");
        return new RedisEventBuffer();
      }
      return new LocalEventBuffer();
    })();
  }
  return eventBufferPromise;
}

/** Shutdown all infrastructure adapters. */
export async function shutdownInfra(): Promise<void> {
  // Resolve all pending singletons before tearing down.
  // RateLimiterFactory has no shutdown — its Redis connection is shared and closed by closeRedis().
  const [ps, ch, eb] = await Promise.all([pubsubPromise, cachePromise, eventBufferPromise]);
  // Ensure rate limiter promise is settled (no dangling async) before nullifying
  await rateLimiterPromise;
  await Promise.all([ps?.shutdown(), ch?.shutdown(), eb?.shutdown()]);
  pubsubPromise = null;
  cachePromise = null;
  rateLimiterPromise = null;
  eventBufferPromise = null;
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
