// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import type { Context, Next } from "hono";
import { getEeRedis } from "./redis.ts";
import { logger } from "./logger.ts";
import { problemJson, rateLimited } from "./http-errors.ts";

const WINDOW_MS = 60_000;

// Atomic fixed-window counter: INCR, and PEXPIRE only on the first hit of the
// window. Doing both in one Lua call removes the INCR-then-EXPIRE gap where a
// crash could leave a TTL-less key that blocks the org forever.
const RATE_LIMIT_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

/**
 * Rate limiter for EE billing routes.
 *
 * Posture: **fail-open**. When Redis is unconfigured OR errors, the request is
 * allowed. These routes are admin-gated (`billing:manage`) and Stripe-side
 * rate-limited, so availability beats strict local limiting — a Redis blip must
 * not block checkout/portal. The previous code failed open when Redis was
 * absent but failed closed (500) when Redis was down; this makes both paths
 * consistent.
 */
export function eeRateLimit(maxPerMinute: number, keyFn: (c: Context) => string) {
  return async (c: Context, next: Next) => {
    const redis = getEeRedis();
    if (!redis) return next(); // No Redis — fail open

    const key = `ratelimit:${keyFn(c)}`;

    let count: number;
    try {
      count = Number(await redis.eval(RATE_LIMIT_LUA, 1, key, String(WINDOW_MS)));
    } catch (err) {
      logger.warn("rate limit check failed — allowing request (fail-open)", {
        key,
        err: err instanceof Error ? err.message : String(err),
      });
      return next();
    }

    if (count > maxPerMinute) {
      let ttl = 60;
      try {
        ttl = await redis.ttl(key);
      } catch {
        // best-effort Retry-After
      }
      return problemJson(c, rateLimited(Math.max(ttl, 1)));
    }

    return next();
  };
}
