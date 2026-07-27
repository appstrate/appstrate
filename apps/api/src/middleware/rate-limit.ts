// SPDX-License-Identifier: Apache-2.0

import type { RateLimiterAbstract } from "rate-limiter-flexible";
import type { Context, Next } from "hono";
import { parseBearer } from "@appstrate/core/bearer";
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

/**
 * The path component of a limiter key: the matched ROUTE PATTERN, never the
 * concrete path.
 *
 * `c.req.path` is the literal URL, so `/api/documents/{id}/content` used to get
 * one bucket PER DOCUMENT: 120 requests/min each, every one able to proxy up to
 * 100 MiB — i.e. 120 × N downloads/min for N ids, which is no limit at all. The
 * same geometry applied to every `:param` route (previews, per-run reads, …).
 * Keying on the pattern gives the route ONE bucket per identity, which is what
 * a "120/min on this endpoint" limit is supposed to mean.
 *
 * Fixed paths are unaffected — their pattern IS their path, so existing buckets
 * keep the exact same key. The `*` fallback covers a limiter mounted as
 * catch-all middleware (`app.use("*", …)`), where the pattern carries no
 * information and collapsing every endpoint into one bucket would be wrong: we
 * fall back to the concrete path there.
 */
function limiterPath(c: Context<AppEnv>): string {
  const pattern = c.req.routePath;
  return pattern && !pattern.includes("*") ? pattern : c.req.path;
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
    return `${c.req.method}:${limiterPath(c)}:${identity}`;
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
    const token = parseBearer(c.req.header("Authorization"))?.split(".")[0] ?? "unknown";
    return `internal:${limiterPath(c)}:${token}`;
  },
  emitHeaders: false,
});

/** IP-based rate limiter for public (unauthenticated) routes. */
export const rateLimitByIp = createRateLimitMiddleware({
  category: "ip",
  extractKey: (c) => `ip:${c.req.method}:${limiterPath(c)}:${getClientIp(c)}`,
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
 * Coarse, per-IP budget for REJECTED run-sink authentications, consumed by
 * `middleware/verify-run-signature.ts` before it trusts anything.
 *
 * The run-HMAC routes take their identity from the `:runId` path param, so the
 * fine-grained `rateLimitByRunId` / `rateLimitRunDocuments` limiters can only
 * be applied AFTER the signature proves the caller is that run — applying them
 * first lets anyone who knows a runId burn a legitimate run's ingestion budget
 * with unsigned garbage. But with nothing in front, every attempt (including a
 * flood of random runIds) costs one DB round-trip.
 *
 * A plain per-request IP limiter cannot fill that slot: run containers and CI
 * runners sit behind one NAT egress address, so a whole instance's signed,
 * legitimate event traffic shares a single IP bucket, and any cap tight enough
 * to matter would throttle production. So this limiter counts only FAILURES:
 *
 *   - `assertRunSinkAuthBudget(c)` — 429 once the client has burned its budget,
 *     evaluated before any DB read.
 *   - `recordRunSinkAuthFailure(c)` — one point per rejected attempt (unknown
 *     run, closed sink, bad/replayed signature).
 *
 * A caller holding the run secret never consumes a point, so there is no false
 * positive; a caller without it is capped at 20 failed attempts per second per
 * IP, which bounds the pre-auth DB work to something the database does not
 * notice while making runId guessing hopeless. The window is deliberately
 * SHORT (10 s, not a minute): the cap is a rate, and a short window recovers
 * fast, so a legitimate burst of terminal-race rejections (a fleet of runners
 * behind one NAT egress all hitting `run_sink_closed` at once) clears in
 * seconds instead of locking the address out for a minute.
 */
const RUN_SINK_AUTH_FAILURES = 200;
const RUN_SINK_AUTH_WINDOW_SEC = 10;

async function runSinkAuthLimiter(): Promise<RateLimiterAbstract> {
  const cacheKey = `run-sink-auth:${RUN_SINK_AUTH_FAILURES}:${RUN_SINK_AUTH_WINDOW_SEC}`;
  let limiter = limiters.get(cacheKey);
  if (!limiter) {
    limiter = await createLimiter(
      RUN_SINK_AUTH_FAILURES,
      RUN_SINK_AUTH_WINDOW_SEC,
      `rl:run-sink-auth:w${RUN_SINK_AUTH_WINDOW_SEC}:`,
    );
    limiters.set(cacheKey, limiter);
  }
  return limiter;
}

/** Key: the client IP alone — the route pattern is irrelevant, the budget is the client's. */
function runSinkAuthKey(c: Context<AppEnv>): string {
  return `run-sink-auth:${getClientIp(c)}`;
}

/** Throw 429 when this client has exhausted its failed-authentication budget. */
export async function assertRunSinkAuthBudget(c: Context<AppEnv>): Promise<void> {
  const limiter = await runSinkAuthLimiter();
  const res = await limiter.get(runSinkAuthKey(c));
  if (res && res.remainingPoints <= 0) {
    throwRateLimited(
      RUN_SINK_AUTH_FAILURES,
      RUN_SINK_AUTH_WINDOW_SEC,
      Math.ceil(res.msBeforeNext / 1000),
    );
  }
}

/**
 * Charge one failed run-sink authentication to this client. Never throws —
 * the caller is already on its way to rejecting the request with the real
 * error, which must not be masked by a limiter fault.
 */
export async function recordRunSinkAuthFailure(c: Context<AppEnv>): Promise<void> {
  try {
    const limiter = await runSinkAuthLimiter();
    await limiter.penalty(runSinkAuthKey(c), 1);
  } catch {
    // Best-effort accounting: a limiter/Redis fault must not convert an
    // authentication rejection into a 500.
  }
}

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
