// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../src/types/index.ts";
import {
  rateLimit,
  rateLimitByIp,
  rateLimitByBearer,
  resetRateLimiters,
} from "../../src/middleware/rate-limit.ts";
import { requestId } from "../../src/middleware/request-id.ts";
import { errorHandler } from "../../src/middleware/error-handler.ts";
import { flushRedis } from "../helpers/redis.ts";

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
