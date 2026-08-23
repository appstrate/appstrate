// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import type { Context } from "hono";
import { _resetCacheForTesting } from "@appstrate/env";
import type { AppEnv } from "../../src/types/index.ts";
import {
  rateLimit,
  rateLimitByIp,
  rateLimitByBearer,
  resetRateLimiters,
} from "../../src/middleware/rate-limit.ts";
import { requestId } from "../../src/middleware/request-id.ts";
import { errorHandler } from "../../src/middleware/error-handler.ts";
import { resetClientIpCache } from "../../src/lib/client-ip.ts";
import { flushRedis } from "../helpers/redis.ts";

// `rateLimitByIp` derives the key from `getClientIp(c)` which honors
// `X-Forwarded-For` / `X-Real-IP` only when `TRUST_PROXY > 0`. Hono's
// in-process `app.request()` has no real socket, so without a trust-proxy
// hop the resolver falls back to `"unknown"` for every call and tests
// that assert per-IP differentiation ("different IPs have separate
// limits") can never pass. Pin TRUST_PROXY=1 for the duration of this
// suite and restore the previous value on teardown.
const SNAPSHOT_TRUST_PROXY = process.env.TRUST_PROXY;
beforeAll(() => {
  process.env.TRUST_PROXY = "1";
  _resetCacheForTesting();
  resetClientIpCache();
});
afterAll(() => {
  if (SNAPSHOT_TRUST_PROXY === undefined) {
    delete process.env.TRUST_PROXY;
  } else {
    process.env.TRUST_PROXY = SNAPSHOT_TRUST_PROXY;
  }
  _resetCacheForTesting();
  resetClientIpCache();
});

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use("*", requestId());
  return app;
}

describe("rateLimit (authenticated)", () => {
  beforeEach(async () => {
    resetRateLimiters();
    await flushRedis();
  });

  it("allows requests within the limit", async () => {
    const app = createApp();
    app.use("/test", async (c, next) => {
      c.set("user", { id: "user-1", email: "test@test.com", name: "Test" });
      return rateLimit(5)(c, next);
    });
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });

  it("sets IETF RateLimit structured header on success", async () => {
    const app = createApp();
    app.use("/test", async (c, next) => {
      c.set("user", { id: "user-ietf", email: "test@test.com", name: "Test" });
      return rateLimit(10)(c, next);
    });
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(200);

    const rl = res.headers.get("RateLimit");
    expect(rl).toBeDefined();
    expect(rl).toContain("limit=10");
    expect(rl).toContain("remaining=");
    expect(rl).toContain("reset=");

    const policy = res.headers.get("RateLimit-Policy");
    expect(policy).toBe("10;w=60");
  });

  it("returns 429 when limit exceeded", async () => {
    const app = createApp();
    app.use("/test", async (c, next) => {
      c.set("user", { id: "user-limit", email: "test@test.com", name: "Test" });
      return rateLimit(2)(c, next);
    });
    app.get("/test", (c) => c.json({ ok: true }));

    await app.request("/test");
    await app.request("/test");

    const res = await app.request("/test");
    expect(res.status).toBe(429);
    const body = (await res.json()) as any;
    expect(body.code).toBe("rate_limited");
    expect(body.detail).toContain("Too many requests");
  });

  it("returns IETF headers and Retry-After on 429", async () => {
    const app = createApp();
    app.use("/test", async (c, next) => {
      c.set("user", { id: "user-ietf-429", email: "test@test.com", name: "Test" });
      return rateLimit(1)(c, next);
    });
    app.get("/test", (c) => c.json({ ok: true }));

    await app.request("/test");
    const res = await app.request("/test");
    expect(res.status).toBe(429);

    expect(res.headers.get("Retry-After")).toBeDefined();

    const rl = res.headers.get("RateLimit");
    expect(rl).toBeDefined();
    expect(rl).toContain("limit=1");
    expect(rl).toContain("remaining=0");

    const policy = res.headers.get("RateLimit-Policy");
    expect(policy).toBe("1;w=60");
  });

  it("uses apiKeyId as identity when present", async () => {
    const app = createApp();
    app.use("/test", async (c, next) => {
      c.set("user", { id: "user-1", email: "test@test.com", name: "Test" });
      c.set("apiKeyId", "key-429");
      return rateLimit(2)(c, next);
    });
    app.get("/test", (c) => c.json({ ok: true }));

    await app.request("/test");
    await app.request("/test");
    const res = await app.request("/test");
    expect(res.status).toBe(429);
  });

  it("different users have separate rate limits", async () => {
    const app = createApp();
    let userId = "user-a";
    app.use("/test", async (c, next) => {
      c.set("user", { id: userId, email: "test@test.com", name: "Test" });
      return rateLimit(1)(c, next);
    });
    app.get("/test", (c) => c.json({ ok: true }));

    const res1 = await app.request("/test");
    expect(res1.status).toBe(200);

    userId = "user-b";
    const res2 = await app.request("/test");
    expect(res2.status).toBe(200);
  });
});

describe("deprecated path aliases share one bucket", () => {
  beforeEach(async () => {
    resetRateLimiters();
    await flushRedis();
  });

  // #1177 registers every `/api/files…` route a second time under its
  // pre-rename `/api/documents…` spelling, on the SAME handler. The limiter
  // keys on the matched ROUTE PATTERN, so without canonicalization the alias
  // gets its own bucket and a client that alternates spellings gets double the
  // budget the endpoint declares.
  it("keys a legacy `/documents` route into the same bucket as its `/files` twin", async () => {
    const app = createApp();
    app.use("*", async (c, next) => {
      c.set("user", { id: "user-alias", email: "test@test.com", name: "Test" });
      return next();
    });
    const files = new Hono<AppEnv>();
    const handler = (c: Context<AppEnv>) => c.json({ ok: true });
    files.get("/files/:id", rateLimit(1), handler);
    files.get("/documents/:id", rateLimit(1), handler);
    app.route("/api", files);

    const canonical = await app.request("/api/files/doc_1");
    expect(canonical.status).toBe(200);

    // Same identity, same endpoint, other spelling — must be the SAME bucket.
    const legacy = await app.request("/api/documents/doc_1");
    expect(legacy.status).toBe(429);
  });

  // The preview pair is IP-keyed and unauthenticated, so a split bucket there
  // doubles an ANONYMOUS caller's budget.
  it("keys the legacy preview alias into the same IP bucket as its twin", async () => {
    const app = createApp();
    const preview = new Hono<AppEnv>();
    const handler = (c: Context<AppEnv>) => c.json({ ok: true });
    preview.get("/preview/files/:id", rateLimitByIp(1), handler);
    preview.get("/preview/documents/:id", rateLimitByIp(1), handler);
    app.route("/", preview);

    const headers = { "X-Forwarded-For": "33.33.33.33" };
    const canonical = await app.request("/preview/files/doc_1", { headers });
    expect(canonical.status).toBe(200);

    const legacy = await app.request("/preview/documents/doc_1", { headers });
    expect(legacy.status).toBe(429);
  });

  // Guard against the blunt fix: canonicalization must not fold DIFFERENT
  // endpoints together. `/api/files` and `/api/files/:id` stay separate.
  it("keeps distinct endpoints in distinct buckets", async () => {
    const app = createApp();
    app.use("*", async (c, next) => {
      c.set("user", { id: "user-distinct", email: "test@test.com", name: "Test" });
      return next();
    });
    const files = new Hono<AppEnv>();
    const handler = (c: Context<AppEnv>) => c.json({ ok: true });
    files.get("/files", rateLimit(1), handler);
    files.get("/files/:id", rateLimit(1), handler);
    app.route("/api", files);

    expect((await app.request("/api/files")).status).toBe(200);
    expect((await app.request("/api/files/doc_1")).status).toBe(200);
  });
});

describe("rateLimitByIp", () => {
  beforeEach(async () => {
    resetRateLimiters();
    await flushRedis();
  });

  it("allows requests within the limit", async () => {
    const app = createApp();
    app.use("/public", rateLimitByIp(5));
    app.get("/public", (c) => c.json({ ok: true }));

    const res = await app.request("/public", {
      headers: { "X-Forwarded-For": "1.2.3.4" },
    });
    expect(res.status).toBe(200);
  });

  it("sets IETF RateLimit headers on success", async () => {
    const app = createApp();
    app.use("/public", rateLimitByIp(10));
    app.get("/public", (c) => c.json({ ok: true }));

    const res = await app.request("/public", {
      headers: { "X-Forwarded-For": "99.99.99.99" },
    });
    expect(res.status).toBe(200);

    const rl = res.headers.get("RateLimit");
    expect(rl).toBeDefined();
    expect(rl).toContain("limit=10");

    expect(res.headers.get("RateLimit-Policy")).toBe("10;w=60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeDefined();
  });

  it("returns 429 when IP limit exceeded", async () => {
    const app = createApp();
    app.use("/public", rateLimitByIp(2));
    app.get("/public", (c) => c.json({ ok: true }));

    const headers = { "X-Forwarded-For": "5.6.7.8" };
    await app.request("/public", { headers });
    await app.request("/public", { headers });
    const res = await app.request("/public", { headers });
    expect(res.status).toBe(429);
  });

  it("uses x-real-ip fallback when x-forwarded-for missing", async () => {
    const app = createApp();
    app.use("/public", rateLimitByIp(2));
    app.get("/public", (c) => c.json({ ok: true }));

    const headers = { "X-Real-Ip": "10.0.0.1" };
    await app.request("/public", { headers });
    await app.request("/public", { headers });
    const res = await app.request("/public", { headers });
    expect(res.status).toBe(429);
  });

  it("different IPs have separate limits", async () => {
    const app = createApp();
    app.use("/public", rateLimitByIp(1));
    app.get("/public", (c) => c.json({ ok: true }));

    const res1 = await app.request("/public", {
      headers: { "X-Forwarded-For": "11.11.11.11" },
    });
    expect(res1.status).toBe(200);

    const res2 = await app.request("/public", {
      headers: { "X-Forwarded-For": "22.22.22.22" },
    });
    expect(res2.status).toBe(200);
  });
});

describe("rateLimitByBearer", () => {
  beforeEach(async () => {
    resetRateLimiters();
    await flushRedis();
  });

  it("allows requests within limit", async () => {
    const app = createApp();
    app.use("/internal", rateLimitByBearer(5));
    app.get("/internal", (c) => c.json({ ok: true }));

    const res = await app.request("/internal", {
      headers: { Authorization: "Bearer exec_abc123.hmac" },
    });
    expect(res.status).toBe(200);
  });

  it("returns 429 when limit exceeded", async () => {
    const app = createApp();
    app.use("/internal", rateLimitByBearer(2));
    app.get("/internal", (c) => c.json({ ok: true }));

    const headers = { Authorization: "Bearer exec_def456.hmac" };
    await app.request("/internal", { headers });
    await app.request("/internal", { headers });
    const res = await app.request("/internal", { headers });
    expect(res.status).toBe(429);
  });

  it("extracts run ID from token for keying", async () => {
    const app = createApp();
    app.use("/internal", rateLimitByBearer(1));
    app.get("/internal", (c) => c.json({ ok: true }));

    const res1 = await app.request("/internal", {
      headers: { Authorization: "Bearer exec_111.hmac1" },
    });
    expect(res1.status).toBe(200);

    const res2 = await app.request("/internal", {
      headers: { Authorization: "Bearer exec_222.hmac2" },
    });
    expect(res2.status).toBe(200);
  });

  it("keys a lowercase `bearer` scheme the same as `Bearer` (RFC 9110 §11.4)", async () => {
    const app = createApp();
    app.use("/internal", rateLimitByBearer(1));
    app.get("/internal", (c) => c.json({ ok: true }));

    const first = await app.request("/internal", {
      headers: { Authorization: "Bearer exec_333.hmac" },
    });
    expect(first.status).toBe(200);

    // Same token, non-canonical scheme — must land in the SAME bucket,
    // not a fresh `unknown` one that would hand out extra budget.
    const second = await app.request("/internal", {
      headers: { Authorization: "bearer exec_333.hmac" },
    });
    expect(second.status).toBe(429);
  });
});
