// SPDX-License-Identifier: Apache-2.0

/**
 * Better Auth's rate-limit storage has two rejection shapes to tell apart, and
 * Better Auth handles neither itself: `onRequestRateLimit` calls `consume` with
 * no try/catch, so whatever this storage throws is a 500 on every
 * `/api/auth/**` route. A spent budget must therefore come back as a value, and
 * only a genuine backend failure may throw — which, with the Redis factory's
 * insurance limiter in place, means both backends failed.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { RateLimiterRes } from "rate-limiter-flexible";
import type { RateLimiterAbstract } from "rate-limiter-flexible";
import {
  betterAuthRateLimitStorage,
  resetBetterAuthRateLimitStorage,
} from "../../../src/infra/rate-limit/better-auth-storage.ts";
import { RedisRateLimiterFactory } from "../../../src/infra/rate-limit/redis-rate-limit.ts";
import type { RateLimiterFactory } from "../../../src/infra/rate-limit/interface.ts";
import { getRedisConnection } from "../../../src/lib/redis.ts";

/** A factory handing out one caller-supplied limiter, whatever the rule. */
function factoryOf(limiter: RateLimiterAbstract): RateLimiterFactory {
  return { create: () => limiter };
}

function limiterRejectingWith(rejection: unknown): RateLimiterAbstract {
  return { consume: () => Promise.reject(rejection) } as unknown as RateLimiterAbstract;
}

const RULE = { window: 10, max: 3 };

// The storage caches one limiter per (window, max) pair at module scope.
afterEach(() => {
  resetBetterAuthRateLimitStorage();
});

describe("betterAuthRateLimitStorage", () => {
  it("reports a spent budget as a value carrying retryAfter in seconds", async () => {
    const storage = betterAuthRateLimitStorage({
      getFactory: async () =>
        factoryOf(limiterRejectingWith(new RateLimiterRes(0, 2_400, 3, false))),
    });

    expect(await storage.consume("k", RULE)).toEqual({ allowed: false, retryAfter: 3 });
  });

  it("rounds a sub-second wait up to 1 rather than to 0", async () => {
    const storage = betterAuthRateLimitStorage({
      getFactory: async () => factoryOf(limiterRejectingWith(new RateLimiterRes(0, 120, 3, false))),
    });

    expect(await storage.consume("k", RULE)).toEqual({ allowed: false, retryAfter: 1 });
  });

  it("surfaces a backend failure instead of reading it as a clean pass", async () => {
    const storage = betterAuthRateLimitStorage({
      getFactory: async () => factoryOf(limiterRejectingWith(new Error("both backends down"))),
    });

    await expect(storage.consume("k", RULE)).rejects.toThrow("both backends down");
  });

  it("allows a request the limiter accepts", async () => {
    const storage = betterAuthRateLimitStorage({
      getFactory: async () =>
        factoryOf({
          consume: async () => new RateLimiterRes(2, 0, 1, false),
        } as unknown as RateLimiterAbstract),
    });

    expect(await storage.consume("k", RULE)).toEqual({ allowed: true, retryAfter: null });
  });
});

describe("RedisRateLimiterFactory insurance limiter", () => {
  // Enough of an ioredis client for `RateLimiterRedis` to pick its ioredis
  // code path and then fail on the command it issues.
  const failingClient = {
    defineCommand: () => {},
    rlflxIncr: () => Promise.reject(new Error("Connection is closed")),
    multi: () => {
      throw new Error("Connection is closed");
    },
  } as unknown as ReturnType<typeof getRedisConnection>;

  it("answers from memory when the Redis command fails, and still enforces a budget", async () => {
    const limiter = new RedisRateLimiterFactory(() => failingClient).create(2, 60, "insurance:");

    // Redis rejects, the insurance limiter answers — no error reaches here.
    expect((await limiter.consume("client", 1)).remainingPoints).toBe(1);
    expect((await limiter.consume("client", 1)).remainingPoints).toBe(0);

    // And it is a real budget, not a pass-through: the third request is
    // rejected with a `RateLimiterRes`, the shape the storage above reads.
    const spent: unknown = await limiter.consume("client", 1).catch((e: unknown) => e);
    expect(spent).toBeInstanceOf(RateLimiterRes);
    expect((spent as RateLimiterRes).msBeforeNext).toBeGreaterThan(0);
  });
});
