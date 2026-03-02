import { createBucketStore } from "@appstrate/core/rate-limit";
import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";

const store = createBucketStore();

export function rateLimit(maxPerMinute: number) {
  return async (c: Context<AppEnv>, next: Next) => {
    const user = c.get("user");
    const apiKeyId = c.get("apiKeyId");
    const identity = apiKeyId ? `apikey:${apiKeyId}` : user.id;
    const key = `${c.req.method}:${c.req.path}:${identity}`;

    if (!store.consume(key, maxPerMinute, maxPerMinute)) {
      return c.json(
        { error: "RATE_LIMITED", message: "Too many requests. Please try again shortly." },
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

    if (!store.consume(key, maxPerMinute, maxPerMinute)) {
      return c.json(
        { error: "RATE_LIMITED", message: "Too many requests. Please try again shortly." },
        429,
      );
    }

    return next();
  };
}
