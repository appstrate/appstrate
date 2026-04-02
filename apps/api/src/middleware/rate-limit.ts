// SPDX-License-Identifier: Apache-2.0

import { RateLimiterRedis } from "rate-limiter-flexible";
import type { RateLimiterAbstract } from "rate-limiter-flexible";
import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import { getRedisConnection } from "../lib/redis.ts";
import { ApiError } from "../lib/errors.ts";

function createLimiter(points: number, duration: number, keyPrefix: string): RateLimiterAbstract {
  return new RateLimiterRedis({
    storeClient: getRedisConnection(),
    points,
    duration,
    keyPrefix,
  });
}

/** Limiter cache keyed by category + maxPerMinute. */
let limiters = new Map<string, RateLimiterAbstract>();

/** Reset all limiter instances — used by tests to get fresh limiters between test cases. */
export function resetRateLimiters(): void {
  limiters = new Map();
}

/** Extract retryAfter (seconds) from rate-limiter-flexible rejection. */
function extractRetryAfter(rej: unknown): number | undefined {
  return rej && typeof rej === "object" && "msBeforeNext" in rej
    ? Math.ceil((rej as { msBeforeNext: number }).msBeforeNext / 1000)
    : undefined;
}

/** Throw a 429 ApiError with IETF rate-limit headers. */
function throwRateLimited(maxPerMinute: number, retryAfter: number | undefined): never {
  const reset = retryAfter ?? 60;
  throw new ApiError({
    status: 429,
    code: "rate_limited",
    title: "Rate Limited",
    detail: "Too many requests. Please try again shortly.",
    retryAfter,
    headers: {
      "Retry-After": String(reset),
      RateLimit: `limit=${maxPerMinute}, remaining=0, reset=${reset}`,
      "RateLimit-Policy": `${maxPerMinute};w=60`,
    },
  });
}

/** Set IETF rate-limit headers on a successful response. */
function setRateLimitHeaders(
  c: Context,
  maxPerMinute: number,
  remaining: number,
  reset: number,
): void {
  c.header("RateLimit", `limit=${maxPerMinute}, remaining=${remaining}, reset=${reset}`);
  c.header("RateLimit-Policy", `${maxPerMinute};w=60`);
}

interface RateLimiterConfig {
  /** Category prefix for limiter cache and Redis key prefix (e.g. "auth", "bearer", "ip"). */
  category: string;
  /** Extract the identity key from the request context. */
  extractKey: (c: Context<AppEnv>) => string;
  /** Whether to set rate-limit response headers on success. */
  emitHeaders: boolean;
}

/**
 * Internal factory — creates a rate-limiting middleware from a configuration.
 * Handles limiter caching, consumption, headers, and 429 responses.
 */
function createRateLimitMiddleware(config: RateLimiterConfig) {
  return (maxPerMinute: number) => {
    return async (c: Context<AppEnv>, next: Next) => {
      const cacheKey = `${config.category}:${maxPerMinute}`;
      let limiter = limiters.get(cacheKey);
      if (!limiter) {
        limiter = createLimiter(maxPerMinute, 60, `rl:${config.category}:`);
        limiters.set(cacheKey, limiter);
      }

      const key = config.extractKey(c);

      try {
        const res = await limiter.consume(key);
        if (config.emitHeaders) {
          setRateLimitHeaders(
            c,
            maxPerMinute,
            res.remainingPoints,
            Math.ceil(res.msBeforeNext / 1000),
          );
        }
        return next();
      } catch (rej) {
        throwRateLimited(maxPerMinute, extractRetryAfter(rej));
      }
    };
  };
}

/**
 * Authenticated rate limiter keyed by user ID or API key.
 */
export const rateLimit = createRateLimitMiddleware({
  category: "auth",
  extractKey: (c) => {
    const user = c.get("user");
    const apiKeyId = c.get("apiKeyId");
    const identity = apiKeyId ? `apikey:${apiKeyId}` : user.id;
    return `${c.req.method}:${c.req.path}:${identity}`;
  },
  emitHeaders: true,
});

/** Bearer token-based rate limiter for internal container routes. */
export const rateLimitByBearer = createRateLimitMiddleware({
  category: "bearer",
  extractKey: (c) => {
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.startsWith("Bearer ")
      ? (auth.slice(7).split(".")[0] ?? "unknown")
      : "unknown";
    return `internal:${c.req.path}:${token}`;
  },
  emitHeaders: false,
});

/** IP-based rate limiter for public (unauthenticated) routes. */
export const rateLimitByIp = createRateLimitMiddleware({
  category: "ip",
  extractKey: (c) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown";
    return `ip:${c.req.method}:${c.req.path}:${ip}`;
  },
  emitHeaders: true,
});
