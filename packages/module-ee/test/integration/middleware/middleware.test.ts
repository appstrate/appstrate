// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { describe, expect, it, beforeEach } from "bun:test";
import { Hono } from "hono";
import { flushEeRedis } from "../../helpers/redis.ts";
import { eeRateLimit, eeRequireAdmin } from "../../../src/middleware.ts";
import type { OrgRole } from "../../../src/types.ts";
import { useEeTestSeams } from "../../helpers/setup.ts";

useEeTestSeams();

describe("middleware", () => {
  beforeEach(async () => {
    await flushEeRedis();
  });

  describe("eeRateLimit", () => {
    function createRateLimitApp(maxPerMinute: number) {
      const app = new Hono();
      app.use(
        "/test",
        eeRateLimit(maxPerMinute, (c) => `test:${c.req.header("X-Client-Id") ?? "default"}`),
      );
      app.get("/test", (c) => c.json({ ok: true }));
      return app;
    }

    it("allows requests within the rate limit", async () => {
      const app = createRateLimitApp(3);

      const res = await app.request("/test", {
        headers: { "X-Client-Id": "client-a" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
    });

    it("returns 429 when rate limit is exceeded", async () => {
      const app = createRateLimitApp(2);

      // First two requests pass
      for (let i = 0; i < 2; i++) {
        const res = await app.request("/test", {
          headers: { "X-Client-Id": "client-b" },
        });
        expect(res.status).toBe(200);
      }

      // Third request should be rate limited
      const res = await app.request("/test", {
        headers: { "X-Client-Id": "client-b" },
      });
      expect(res.status).toBe(429);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      const body = (await res.json()) as { code: string; status: number };
      expect(body.code).toBe("rate_limited");
      expect(body.status).toBe(429);
    });

    it("tracks different keys independently", async () => {
      const app = createRateLimitApp(1);

      // Client A first request passes
      const resA = await app.request("/test", {
        headers: { "X-Client-Id": "client-c" },
      });
      expect(resA.status).toBe(200);

      // Client B first request also passes (different key)
      const resB = await app.request("/test", {
        headers: { "X-Client-Id": "client-d" },
      });
      expect(resB.status).toBe(200);

      // Client A second request should be rate limited
      const resA2 = await app.request("/test", {
        headers: { "X-Client-Id": "client-c" },
      });
      expect(resA2.status).toBe(429);
    });

    it("includes Retry-After header on 429 response", async () => {
      const app = createRateLimitApp(1);

      // Exhaust limit
      await app.request("/test", {
        headers: { "X-Client-Id": "client-e" },
      });

      // Rate limited request
      const res = await app.request("/test", {
        headers: { "X-Client-Id": "client-e" },
      });
      expect(res.status).toBe(429);

      const retryAfter = res.headers.get("Retry-After");
      expect(retryAfter).toBeDefined();
      expect(Number(retryAfter)).toBeGreaterThan(0);
    });
  });

  describe("eeRequireAdmin", () => {
    function createAdminApp() {
      const app = new Hono<{
        Variables: { orgRole: OrgRole; permissions: ReadonlySet<string> };
      }>();
      app.use("/admin", async (c, next) => {
        const role = c.req.header("X-Role") as OrgRole | undefined;
        if (role) c.set("orgRole", role);
        // Simulate platform RBAC: admin/owner roles get billing:manage permission
        const permissions =
          role === "owner" || role === "admin" ? new Set(["billing:manage"]) : new Set<string>();
        c.set("permissions", permissions);
        await next();
      });
      app.use("/admin", eeRequireAdmin());
      app.get("/admin", (c) => c.json({ ok: true }));
      return app;
    }

    it("allows owner role", async () => {
      const app = createAdminApp();

      const res = await app.request("/admin", {
        headers: { "X-Role": "owner" },
      });
      expect(res.status).toBe(200);
    });

    it("allows admin role", async () => {
      const app = createAdminApp();

      const res = await app.request("/admin", {
        headers: { "X-Role": "admin" },
      });
      expect(res.status).toBe(200);
    });

    it("rejects member role with 403", async () => {
      const app = createAdminApp();

      const res = await app.request("/admin", {
        headers: { "X-Role": "member" },
      });
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      const body = (await res.json()) as { code: string; status: number };
      expect(body.code).toBe("forbidden");
      expect(body.status).toBe(403);
    });

    it("rejects when no role is set with 403", async () => {
      const app = createAdminApp();

      const res = await app.request("/admin");
      expect(res.status).toBe(403);
    });
  });
});
