import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Hono } from "hono";

// Mock redis to avoid env validation (we use in-memory backend for tests).
// Must export ALL redis functions since mock.module is process-global in bun:test.
mock.module("../../lib/redis.ts", () => ({
  getRedisConnection: () => ({}),
  getRedisPublisher: () => ({
    publish: () => Promise.resolve(1),
  }),
  getRedisSubscriber: () => ({
    subscribe: (_ch: string, cb: (err: Error | null) => void) => cb(null),
    unsubscribe: () => Promise.resolve(),
    on: () => {},
  }),
}));

const {
  rateLimit,
  rateLimitByIp,
  rateLimitByBearer,
  _resetBucketsForTesting,
  _setMemoryBackendForTesting,
} = await import("../rate-limit.ts");

// Use in-memory backend for tests (no Redis required)
_setMemoryBackendForTesting(true);

describe("rate-limit", () => {
  beforeEach(() => {
    _resetBucketsForTesting();
  });

  describe("rateLimit (by user)", () => {
    function createApp(limit: number) {
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("user" as never, { id: "user1", email: "test@test.com", name: "Test" });
        c.set("orgId" as never, "org1");
        c.set("orgRole" as never, "admin");
        c.set("authMethod" as never, "session");
        await next();
      });
      app.get("/test", rateLimit(limit) as never, (c) => c.json({ ok: true }));
      return app;
    }

    test("allows requests under limit", async () => {
      const app = createApp(5);
      const res = await app.request("/test");
      expect(res.status).toBe(200);
      expect(res.headers.get("X-RateLimit-Remaining")).toBeDefined();
    });

    test("blocks after exceeding limit", async () => {
      const app = createApp(3);

      for (let i = 0; i < 3; i++) {
        const res = await app.request("/test");
        expect(res.status).toBe(200);
      }

      const res = await app.request("/test");
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("RATE_LIMITED");
    });

    test("uses different buckets for different users", async () => {
      let userId = "user-a";
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("user" as never, { id: userId, email: "test@test.com", name: "Test" });
        c.set("orgId" as never, "org1");
        c.set("orgRole" as never, "admin");
        c.set("authMethod" as never, "session");
        await next();
      });
      app.get("/test", rateLimit(2) as never, (c) => c.json({ ok: true }));

      // Exhaust user-a
      await app.request("/test");
      await app.request("/test");

      // user-b should still work
      userId = "user-b";
      const res = await app.request("/test");
      expect(res.status).toBe(200);
    });

    test("uses different buckets for different paths", async () => {
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("user" as never, { id: "user1", email: "test@test.com", name: "Test" });
        c.set("orgId" as never, "org1");
        c.set("orgRole" as never, "admin");
        c.set("authMethod" as never, "session");
        await next();
      });
      app.get("/a", rateLimit(1) as never, (c) => c.json({ ok: true }));
      app.get("/b", rateLimit(1) as never, (c) => c.json({ ok: true }));

      await app.request("/a");
      const res = await app.request("/b");
      expect(res.status).toBe(200);
    });
  });

  describe("rateLimitByIp", () => {
    test("allows requests under limit", async () => {
      const app = new Hono();
      app.get("/test", rateLimitByIp(5) as never, (c) => c.json({ ok: true }));

      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "1.2.3.4" },
      });
      expect(res.status).toBe(200);
    });

    test("blocks after exceeding limit", async () => {
      const app = new Hono();
      app.get("/test", rateLimitByIp(2) as never, (c) => c.json({ ok: true }));

      for (let i = 0; i < 2; i++) {
        await app.request("/test", {
          headers: { "x-forwarded-for": "5.6.7.8" },
        });
      }

      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "5.6.7.8" },
      });
      expect(res.status).toBe(429);
    });

    test("uses x-forwarded-for for IP", async () => {
      const app = new Hono();
      app.get("/test", rateLimitByIp(1) as never, (c) => c.json({ ok: true }));

      await app.request("/test", {
        headers: { "x-forwarded-for": "10.0.0.1" },
      });

      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "10.0.0.2" },
      });
      expect(res.status).toBe(200);
    });

    test("uses x-real-ip as fallback", async () => {
      const app = new Hono();
      app.get("/test", rateLimitByIp(1) as never, (c) => c.json({ ok: true }));

      await app.request("/test", {
        headers: { "x-real-ip": "192.168.1.1" },
      });

      const res = await app.request("/test", {
        headers: { "x-real-ip": "192.168.1.1" },
      });
      expect(res.status).toBe(429);
    });

    test("returns RATE_LIMITED error body", async () => {
      const app = new Hono();
      app.get("/test", rateLimitByIp(1) as never, (c) => c.json({ ok: true }));

      await app.request("/test", {
        headers: { "x-forwarded-for": "99.99.99.99" },
      });

      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "99.99.99.99" },
      });
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("RATE_LIMITED");
      expect(body.message).toContain("Too many requests");
    });
  });

  describe("rateLimitByBearer", () => {
    test("allows requests with different tokens", async () => {
      const app = new Hono();
      app.get("/test", rateLimitByBearer(1) as never, (c) => c.json({ ok: true }));

      await app.request("/test", {
        headers: { Authorization: "Bearer exec1.hmac" },
      });

      const res = await app.request("/test", {
        headers: { Authorization: "Bearer exec2.hmac" },
      });
      expect(res.status).toBe(200);
    });

    test("blocks same token after exceeding limit", async () => {
      const app = new Hono();
      app.get("/test", rateLimitByBearer(1) as never, (c) => c.json({ ok: true }));

      await app.request("/test", {
        headers: { Authorization: "Bearer exec1.hmac" },
      });

      const res = await app.request("/test", {
        headers: { Authorization: "Bearer exec1.hmac" },
      });
      expect(res.status).toBe(429);
    });
  });

  describe("_resetBucketsForTesting", () => {
    test("clears all buckets", async () => {
      const app = new Hono();
      app.get("/test", rateLimitByIp(1) as never, (c) => c.json({ ok: true }));

      await app.request("/test", {
        headers: { "x-forwarded-for": "clear.test.ip" },
      });

      let res = await app.request("/test", {
        headers: { "x-forwarded-for": "clear.test.ip" },
      });
      expect(res.status).toBe(429);

      _resetBucketsForTesting();

      res = await app.request("/test", {
        headers: { "x-forwarded-for": "clear.test.ip" },
      });
      expect(res.status).toBe(200);
    });
  });
});
