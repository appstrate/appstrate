import { RateLimiterRedis, RateLimiterMemory } from "rate-limiter-flexible";
import type { RateLimiterAbstract } from "rate-limiter-flexible";
import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import { getRedisConnection } from "../lib/redis.ts";
import { ApiError } from "../lib/errors.ts";

/**
 * Creates a rate limiter — Redis-backed in production, in-memory for tests.
 * The `_useMemoryForTesting` flag lets tests run without Redis.
 */
let _useMemoryForTesting = false;

export function _setMemoryBackendForTesting(value: boolean): void {
  _useMemoryForTesting = value;
}

function createLimiter(points: number, duration: number, keyPrefix: string): RateLimiterAbstract {
  if (_useMemoryForTesting) {
    return new RateLimiterMemory({ points, duration, keyPrefix });
  }
  return new RateLimiterRedis({
    storeClient: getRedisConnection(),
    points,
    duration,
    keyPrefix,
  });
}

let authLimiters = new Map<string, RateLimiterAbstract>();
let bearerLimiters = new Map<string, RateLimiterAbstract>();
let ipLimiters = new Map<string, RateLimiterAbstract>();

export function _resetBucketsForTesting(): void {
  authLimiters = new Map();
  bearerLimiters = new Map();
  ipLimiters = new Map();
}

/**
 * Authenticated rate limiter keyed by user ID or API key.
 * Adds `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers on success.
 */
export function rateLimit(maxPerMinute: number) {
  return async (c: Context<AppEnv>, next: Next) => {
    const limiterKey = `auth:${maxPerMinute}`;
    let limiter = authLimiters.get(limiterKey);
    if (!limiter) {
      limiter = createLimiter(maxPerMinute, 60, "rl:auth:");
      authLimiters.set(limiterKey, limiter);
    }

    const user = c.get("user");
    const apiKeyId = c.get("apiKeyId");
    const identity = apiKeyId ? `apikey:${apiKeyId}` : user.id;
    const key = `${c.req.method}:${c.req.path}:${identity}`;

    try {
      const res = await limiter.consume(key);

      c.header("X-RateLimit-Remaining", String(res.remainingPoints));
      c.header("X-RateLimit-Reset", String(Math.ceil(res.msBeforeNext / 1000)));

      return next();
    } catch (rej) {
      const retryAfter =
        rej && typeof rej === "object" && "msBeforeNext" in rej
          ? Math.ceil((rej as { msBeforeNext: number }).msBeforeNext / 1000)
          : undefined;

      throw new ApiError({
        status: 429,
        code: "rate_limited",
        title: "Rate Limited",
        detail: "Too many requests. Please try again shortly.",
        retryAfter,
      });
    }
  };
}

/** Bearer token-based rate limiter for internal container routes. */
export function rateLimitByBearer(maxPerMinute: number) {
  return async (c: Context, next: Next) => {
    const limiterKey = `bearer:${maxPerMinute}`;
    let limiter = bearerLimiters.get(limiterKey);
    if (!limiter) {
      limiter = createLimiter(maxPerMinute, 60, "rl:bearer:");
      bearerLimiters.set(limiterKey, limiter);
    }

    const auth = c.req.header("Authorization") ?? "";
    // Extract executionId portion (before the HMAC dot) for unique-per-execution keying
    const token = auth.startsWith("Bearer ")
      ? (auth.slice(7).split(".")[0] ?? "unknown")
      : "unknown";
    const key = `internal:${c.req.path}:${token}`;

    try {
      await limiter.consume(key);
      return next();
    } catch (rej) {
      const retryAfter =
        rej && typeof rej === "object" && "msBeforeNext" in rej
          ? Math.ceil((rej as { msBeforeNext: number }).msBeforeNext / 1000)
          : undefined;

      throw new ApiError({
        status: 429,
        code: "rate_limited",
        title: "Rate Limited",
        detail: "Too many requests. Please try again shortly.",
        retryAfter,
      });
    }
  };
}

/** IP-based rate limiter for public (unauthenticated) routes. */
export function rateLimitByIp(maxPerMinute: number) {
  return async (c: Context, next: Next) => {
    const limiterKey = `ip:${maxPerMinute}`;
    let limiter = ipLimiters.get(limiterKey);
    if (!limiter) {
      limiter = createLimiter(maxPerMinute, 60, "rl:ip:");
      ipLimiters.set(limiterKey, limiter);
    }

    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown";
    const key = `ip:${c.req.method}:${c.req.path}:${ip}`;

    try {
      await limiter.consume(key);
      return next();
    } catch (rej) {
      const retryAfter =
        rej && typeof rej === "object" && "msBeforeNext" in rej
          ? Math.ceil((rej as { msBeforeNext: number }).msBeforeNext / 1000)
          : undefined;

      throw new ApiError({
        status: 429,
        code: "rate_limited",
        title: "Rate Limited",
        detail: "Too many requests. Please try again shortly.",
        retryAfter,
      });
    }
  };
}
