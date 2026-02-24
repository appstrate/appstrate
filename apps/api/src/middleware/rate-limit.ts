import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

// Cleanup old buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefill > 5 * 60_000) {
      buckets.delete(key);
    }
  }
}, 5 * 60_000);

function consume(key: string, maxTokens: number, refillPerMinute: number): boolean {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    bucket = { tokens: maxTokens, lastRefill: now };
    buckets.set(key, bucket);
  }

  // Refill tokens based on elapsed time
  const elapsed = now - bucket.lastRefill;
  const refill = (elapsed / 60_000) * refillPerMinute;
  bucket.tokens = Math.min(maxTokens, bucket.tokens + refill);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    return false;
  }

  bucket.tokens -= 1;
  return true;
}

export function rateLimit(maxPerMinute: number) {
  return async (c: Context<AppEnv>, next: Next) => {
    const user = c.get("user");
    const apiKeyId = c.get("apiKeyId");
    const identity = apiKeyId ? `apikey:${apiKeyId}` : user.id;
    const key = `${c.req.method}:${c.req.path}:${identity}`;

    if (!consume(key, maxPerMinute, maxPerMinute)) {
      return c.json(
        { error: "RATE_LIMITED", message: "Trop de requetes. Reessayez dans quelques instants." },
        429,
      );
    }

    return next();
  };
}

/** IP-based rate limiter for public (unauthenticated) routes. */
export function rateLimitByIp(maxPerMinute: number) {
  return async (c: Context, next: Next) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown";
    const key = `ip:${c.req.method}:${c.req.path}:${ip}`;

    if (!consume(key, maxPerMinute, maxPerMinute)) {
      return c.json(
        { error: "RATE_LIMITED", message: "Trop de requetes. Reessayez dans quelques instants." },
        429,
      );
    }

    return next();
  };
}
