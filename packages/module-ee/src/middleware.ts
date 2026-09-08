import type { Context, Next } from "hono";
import { getCloudRedis } from "./redis.ts";
import { logger } from "./logger.ts";
import { problemJson, rateLimited } from "./http-errors.ts";
import { forbidden } from "@appstrate/core/api-errors";

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
 * Rate limiter for cloud billing routes.
 *
 * Posture: **fail-open**. When Redis is unconfigured OR errors, the request is
 * allowed. These routes are admin-gated (`billing:manage`) and Stripe-side
 * rate-limited, so availability beats strict local limiting — a Redis blip must
 * not block checkout/portal. The previous code failed open when Redis was
 * absent but failed closed (500) when Redis was down; this makes both paths
 * consistent.
 */
export function cloudRateLimit(maxPerMinute: number, keyFn: (c: Context) => string) {
  return async (c: Context, next: Next) => {
    const redis = getCloudRedis();
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

/**
 * RBAC guard for cloud billing routes. Checks the `permissions` Set from Hono
 * context (populated by the platform's RBAC middleware). Emits RFC 9457
 * problem+json on denial, matching the platform's core error contract.
 */
export function cloudRequirePermission(permission: string) {
  return async (c: Context, next: Next) => {
    const permissions = c.get("permissions") as ReadonlySet<string> | undefined;
    if (!permissions || !permissions.has(permission)) {
      return problemJson(c, forbidden(`Insufficient permissions: ${permission} required`));
    }
    return next();
  };
}

/** Admin-tier guard — billing mutations (checkout / portal) require `billing:manage`. */
export function cloudRequireAdmin() {
  return cloudRequirePermission("billing:manage");
}
