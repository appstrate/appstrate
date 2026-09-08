// SPDX-License-Identifier: Apache-2.0

/**
 * Better Auth rate-limit storage, backed by the platform's own limiter
 * factory — Redis when `REDIS_URL` is set, in-memory otherwise (`hasRedis()`
 * in `infra/index.ts` owns that choice, so there is no second fallback here).
 *
 * Better Auth's own `memory` storage counts per process, which is no limit at
 * all across replicas. `RateLimiterAbstract.consume` is a single atomic
 * check-and-increment, which is exactly the contract
 * `BetterAuthRateLimitStorage.consume` asks for.
 */

import type { RateLimiterAbstract } from "rate-limiter-flexible";
import type { BetterAuthRateLimitStorage } from "@appstrate/db/auth";
import { getRateLimiterFactory } from "../index.ts";
import type { RateLimiterFactory } from "./interface.ts";

/**
 * Key prefix for every Better Auth bucket. `flushRedis()` clears the whole
 * database in tier3; in tier0 the buckets live in the cached limiters, which
 * {@link resetBetterAuthRateLimitStorage} drops.
 */
const KEY_PREFIX = "rl:better-auth:";

/** One limiter per `(window, max)` pair — same shape as the OIDC guards' cache. */
const limiters = new Map<string, RateLimiterAbstract>();

async function limiterFor(
  window: number,
  max: number,
  getFactory: () => Promise<RateLimiterFactory>,
): Promise<RateLimiterAbstract> {
  const cacheKey = `${window}:${max}`;
  let limiter = limiters.get(cacheKey);
  if (!limiter) {
    const factory = await getFactory();
    limiter = factory.create(max, window, `${KEY_PREFIX}w${window}m${max}:`);
    limiters.set(cacheKey, limiter);
  }
  return limiter;
}

/** Test helper — drops cached limiters so the next call rebuilds them. */
export function resetBetterAuthRateLimitStorage(): void {
  limiters.clear();
}

export function betterAuthRateLimitStorage(
  deps: { getFactory?: () => Promise<RateLimiterFactory> } = {},
): BetterAuthRateLimitStorage {
  const getFactory = deps.getFactory ?? getRateLimiterFactory;
  return {
    async consume(key, rule) {
      const limiter = await limiterFor(rule.window, rule.max, getFactory);
      try {
        await limiter.consume(key, 1);
        return { allowed: true, retryAfter: null };
      } catch (rejection) {
        // `rate-limiter-flexible` rejects with a `RateLimiterRes` when the
        // budget is spent and with an `Error` when the backend failed. The
        // Redis factory carries an in-memory insurance limiter, so an `Error`
        // reaching here means BOTH backends failed: nothing counted the
        // request, and surfacing it — Better Auth turns it into a 500 — is
        // the honest answer where reading it as a clean pass is not.
        if (!rejection || typeof rejection !== "object" || !("msBeforeNext" in rejection)) {
          throw rejection;
        }
        const msBeforeNext = (rejection as { msBeforeNext: number }).msBeforeNext;
        return { allowed: false, retryAfter: Math.max(1, Math.ceil(msBeforeNext / 1000)) };
      }
    },
  };
}
