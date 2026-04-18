// SPDX-License-Identifier: Apache-2.0

import type { RateLimiterAbstract } from "rate-limiter-flexible";
import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import { getRateLimiterFactory } from "../infra/index.ts";
import { ApiError } from "../lib/errors.ts";
import { getClientIp } from "../lib/client-ip.ts";

async function createLimiter(
  points: number,
  duration: number,
  keyPrefix: string,
): Promise<RateLimiterAbstract> {
  return (await getRateLimiterFactory()).create(points, duration, keyPrefix);
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
function throwRateLimited(
  maxPoints: number,
  windowSec: number,
  retryAfter: number | undefined,
): never {
  const reset = retryAfter ?? windowSec;
  throw new ApiError({
    status: 429,
    code: "rate_limited",
    title: "Rate Limited",
    detail: "Too many requests. Please try again shortly.",
    retryAfter,
    headers: {
      "Retry-After": String(reset),
      RateLimit: `limit=${maxPoints}, remaining=0, reset=${reset}`,
      "RateLimit-Policy": `${maxPoints};w=${windowSec}`,
    },
  });
}

/** Set IETF rate-limit headers on a successful response. */
function setRateLimitHeaders(
  c: Context,
  maxPoints: number,
  windowSec: number,
  remaining: number,
  reset: number,
): void {
  c.header("RateLimit", `limit=${maxPoints}, remaining=${remaining}, reset=${reset}`);
  c.header("RateLimit-Policy", `${maxPoints};w=${windowSec}`);
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
 *
 * The returned middleware factory takes `maxPoints` and an optional
 * `windowSec` (default 60). A per-(category, points, window) cache key
 * keeps limiters distinct across windows so tight long-window limits
 * (e.g. 5/15min on device-flow approve) coexist with standard per-minute
 * limits without aliasing.
 */
function createRateLimitMiddleware(config: RateLimiterConfig) {
  return (maxPoints: number, windowSec: number = 60) => {
    return async (c: Context<AppEnv>, next: Next) => {
      const cacheKey = `${config.category}:${maxPoints}:${windowSec}`;
      let limiter = limiters.get(cacheKey);
      if (!limiter) {
        limiter = await createLimiter(maxPoints, windowSec, `rl:${config.category}:w${windowSec}:`);
        limiters.set(cacheKey, limiter);
      }

      const key = config.extractKey(c);

      try {
        const res = await limiter.consume(key);
        if (config.emitHeaders) {
          setRateLimitHeaders(
            c,
            maxPoints,
            windowSec,
            res.remainingPoints,
            Math.ceil(res.msBeforeNext / 1000),
          );
        }
        return next();
      } catch (rej) {
        throwRateLimited(maxPoints, windowSec, extractRetryAfter(rej));
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
  extractKey: (c) => `ip:${c.req.method}:${c.req.path}:${getClientIp(c)}`,
  emitHeaders: true,
});
