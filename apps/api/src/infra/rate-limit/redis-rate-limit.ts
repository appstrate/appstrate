// SPDX-License-Identifier: Apache-2.0

import { RateLimiterMemory, RateLimiterRedis } from "rate-limiter-flexible";
import type { RateLimiterAbstract } from "rate-limiter-flexible";
import { getRedisConnection } from "../../lib/redis.ts";
import type { RateLimiterFactory } from "./interface.ts";

/** The shared request-path Redis client, injectable so tests can stub it. */
type StoreClient = () => ReturnType<typeof getRedisConnection>;

/**
 * Redis-backed limiters with a per-process budget behind them.
 *
 * When Redis is unreachable, `RateLimiterRedis.consume` rejects with an
 * `Error` rather than a `RateLimiterRes` — a shape callers must not read as a
 * decision, and one they mostly cannot handle: Better Auth's
 * `onRequestRateLimit` wraps its storage call in no try/catch, so the
 * rejection leaves every `/api/auth/**` route as a 500 while Redis is down.
 *
 * `insuranceLimiter` is the library's answer, and it is wired here so EVERY
 * limiter built from this factory gets it — auth, OIDC, run and proxy alike.
 * The same points and duration in `RateLimiterMemory` answer whenever the
 * store errors, so the budget degrades from per cluster to per process for the
 * length of the outage instead of disappearing or 500ing. A rejection that
 * reaches a caller therefore means both backends failed.
 *
 * No `rejectIfRedisNotReady`: the shared client already carries a finite
 * `maxRetriesPerRequest` (`lib/redis.ts`), so a command fails fast into the
 * insurance limiter rather than hanging on a reconnect.
 */
export class RedisRateLimiterFactory implements RateLimiterFactory {
  constructor(private readonly storeClient: StoreClient = getRedisConnection) {}

  create(points: number, duration: number, keyPrefix: string): RateLimiterAbstract {
    return new RateLimiterRedis({
      storeClient: this.storeClient(),
      points,
      duration,
      keyPrefix,
      insuranceLimiter: new RateLimiterMemory({ points, duration, keyPrefix }),
    });
  }
}
