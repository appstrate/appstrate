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

/**
 * Rate limiter for the inbound MCP server (`/api/mcp/o/:org`).
 *
 * Keys on the caller's identity at JSON-RPC *envelope* granularity (one POST =
 * one consumed point), independent of how many tools or batched calls the
 * envelope carries. `invoke_operation` re-dispatches through already
 * rate-limited platform routes (defence in depth), but `search`/`describe`
 * touch nothing rate-limited, so this bounds their abuse surface too.
 *
 * The identity resolver is intentionally exhaustive — MCP access is grantable
 * to API keys, dashboard sessions, AND OIDC end-users, so we cannot assume
 * `c.get("user")` is populated. Prefer the most specific identity available
 * and fall back to the client IP so a malformed-auth edge can never key on
 * `undefined`.
 */
export const rateLimitMcp = createRateLimitMiddleware({
  category: "mcp",
  extractKey: (c) => {
    const apiKeyId = c.get("apiKeyId");
    const endUser = c.get("endUser");
    const user = c.get("user");
    const identity = apiKeyId
      ? `apikey:${apiKeyId}`
      : endUser?.id
        ? `enduser:${endUser.id}`
        : user?.id
          ? `user:${user.id}`
          : `ip:${getClientIp(c)}`;
    return `mcp:${identity}`;
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

/**
 * Per-run rate limiter for the unified-runner event ingestion routes
 * (`POST /api/runs/:runId/events` + `/finalize`). The runId path param IS
 * the identity — a misbehaving sink cannot evade the limit by rotating
 * API keys, and a single run's traffic cannot affect another run's budget.
 */
export const rateLimitByRunId = createRateLimitMiddleware({
  category: "run-event",
  extractKey: (c) => `run-event:${c.req.param("runId") ?? "unknown"}`,
  emitHeaders: false,
});

/**
 * Per-run rate limiter for document uploads (`POST /api/runs/:runId/documents`),
 * kept SEPARATE from `rateLimitByRunId` (event ingestion): the end-of-run
 * `outputs/` sweep can burst many small file uploads at once and must neither
 * consume the run's event-stream budget nor be throttled by it (a shared
 * limiter would let a sweep 429 itself). Same runId-keyed anti-evasion property.
 */
export const rateLimitRunDocuments = createRateLimitMiddleware({
  category: "run-document",
  extractKey: (c) => `run-document:${c.req.param("runId") ?? "unknown"}`,
  emitHeaders: false,
});
