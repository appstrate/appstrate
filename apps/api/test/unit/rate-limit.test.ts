import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../src/types/index.ts";
import {
  rateLimit,
  rateLimitByIp,
  rateLimitByBearer,
  _setMemoryBackendForTesting,
  _resetBucketsForTesting,
} from "../../src/middleware/rate-limit.ts";
import { requestId } from "../../src/middleware/request-id.ts";
import { errorHandler } from "../../src/middleware/error-handler.ts";

// Use in-memory backend for all tests
_setMemoryBackendForTesting(true);

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use("*", requestId());
  return app;
}

describe("rateLimit (authenticated)", () => {
  beforeEach(() => {
    _resetBucketsForTesting();
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

  it("sets rate limit headers", async () => {
    const app = createApp();
    app.use("/test", async (c, next) => {
      c.set("user", { id: "user-rl-headers", email: "test@test.com", name: "Test" });
      return rateLimit(10)(c, next);
    });
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Remaining")).toBeDefined();
    expect(res.headers.get("X-RateLimit-Reset")).toBeDefined();
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

describe("rateLimitByIp", () => {
  beforeEach(() => {
    _resetBucketsForTesting();
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
  beforeEach(() => {
    _resetBucketsForTesting();
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

  it("extracts execution ID from token for keying", async () => {
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
});
