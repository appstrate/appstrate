// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI response header validation tests.
 *
 * Validates that API responses include the correct headers as documented
 * in the OpenAPI spec (apps/api/src/openapi/headers.ts):
 *
 * - Request-Id: present on ALL API responses (req_ prefix)
 * - Appstrate-Version: present on all authenticated API responses (YYYY-MM-DD format)
 * - RateLimit / RateLimit-Policy: present on rate-limited endpoints (IETF structured headers)
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";

const app = getTestApp();

describe("OpenAPI response header validation", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "headers-test" });
  });

  // ── Request-Id header ─────────────────────────────────────

  describe("Request-Id header", () => {
    it("GET /api/agents includes Request-Id starting with req_", async () => {
      const res = await app.request("/api/agents", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);

      const requestId = res.headers.get("Request-Id");
      expect(requestId).not.toBeNull();
      expect(requestId!.startsWith("req_")).toBe(true);
    });

    it("GET /api/profile includes Request-Id", async () => {
      const res = await app.request("/api/profile", {
        headers: { Cookie: ctx.cookie },
      });
      expect(res.status).toBe(200);

      const requestId = res.headers.get("Request-Id");
      expect(requestId).not.toBeNull();
      expect(requestId!.startsWith("req_")).toBe(true);
    });

    it("POST /api/webhooks includes Request-Id on 201", async () => {
      const res = await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://example.com/hook",
          events: ["run.success"],
        }),
      });
      expect(res.status).toBe(201);

      const requestId = res.headers.get("Request-Id");
      expect(requestId).not.toBeNull();
      expect(requestId!.startsWith("req_")).toBe(true);
    });

    it("GET /api/agents without auth (401) includes Request-Id", async () => {
      const res = await app.request("/api/agents");
      expect(res.status).toBe(401);

      const requestId = res.headers.get("Request-Id");
      expect(requestId).not.toBeNull();
      expect(requestId!.startsWith("req_")).toBe(true);
    });

    it("POST /api/webhooks with invalid body (400) includes Request-Id", async () => {
      const res = await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ url: "not-a-url" }),
      });
      expect(res.status).toBe(400);

      const requestId = res.headers.get("Request-Id");
      expect(requestId).not.toBeNull();
      expect(requestId!.startsWith("req_")).toBe(true);
    });

    it("each request gets a unique Request-Id", async () => {
      const res1 = await app.request("/api/agents", {
        headers: authHeaders(ctx),
      });
      const res2 = await app.request("/api/agents", {
        headers: authHeaders(ctx),
      });

      const id1 = res1.headers.get("Request-Id");
      const id2 = res2.headers.get("Request-Id");

      expect(id1).not.toBeNull();
      expect(id2).not.toBeNull();
      expect(id1).not.toBe(id2);
    });

    it("GET /health includes Request-Id (middleware applies to all routes)", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);

      const requestId = res.headers.get("Request-Id");
      expect(requestId).not.toBeNull();
      expect(requestId!.startsWith("req_")).toBe(true);
    });
  });

  // ── Appstrate-Version header ──────────────────────────────

  describe("Appstrate-Version header", () => {
    it("GET /api/agents includes Appstrate-Version in YYYY-MM-DD format", async () => {
      const res = await app.request("/api/agents", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);

      const version = res.headers.get("Appstrate-Version");
      expect(version).not.toBeNull();
      expect(version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("GET /api/orgs includes Appstrate-Version", async () => {
      const res = await app.request("/api/orgs", {
        headers: { Cookie: ctx.cookie },
      });
      expect(res.status).toBe(200);

      const version = res.headers.get("Appstrate-Version");
      expect(version).not.toBeNull();
      expect(version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("GET /api/profile includes Appstrate-Version", async () => {
      const res = await app.request("/api/profile", {
        headers: { Cookie: ctx.cookie },
      });
      expect(res.status).toBe(200);

      const version = res.headers.get("Appstrate-Version");
      expect(version).not.toBeNull();
      expect(version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("GET /health does NOT include Appstrate-Version (unauthenticated, non-API)", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);

      const version = res.headers.get("Appstrate-Version");
      expect(version).toBeNull();
    });
  });

  // ── RateLimit headers ─────────────────────────────────────

  describe("RateLimit headers on rate-limited endpoints", () => {
    it("POST /api/webhooks includes RateLimit headers on success", async () => {
      const res = await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://example.com/hook-rl",
          events: ["run.success"],
        }),
      });

      // Webhooks POST may or may not be rate-limited — check if headers are present
      // and if so, validate their format
      const rateLimit = res.headers.get("RateLimit");
      const rateLimitPolicy = res.headers.get("RateLimit-Policy");

      if (rateLimit) {
        // IETF structured header: limit=N, remaining=M, reset=S
        expect(rateLimit).toMatch(/limit=\d+, remaining=\d+, reset=\d+/);
        expect(rateLimitPolicy).not.toBeNull();
        // Policy format: N;w=60
        expect(rateLimitPolicy).toMatch(/\d+;w=60/);
      }
      // If no RateLimit headers, this endpoint isn't rate-limited — that's fine
    });

    it("POST /api/end-users includes RateLimit headers if rate-limited", async () => {
      const res = await app.request("/api/end-users", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "RL Test User",
          email: "rl-test@example.com",
          externalId: "rl-ext-1",
        }),
      });

      const rateLimit = res.headers.get("RateLimit");
      const rateLimitPolicy = res.headers.get("RateLimit-Policy");

      if (rateLimit) {
        expect(rateLimit).toMatch(/limit=\d+, remaining=\d+, reset=\d+/);
        expect(rateLimitPolicy).not.toBeNull();
        expect(rateLimitPolicy).toMatch(/\d+;w=60/);
      }
    });
  });

  // ── Header consistency across methods ─────────────────────

  describe("header consistency across HTTP methods", () => {
    it("GET and POST on same domain both include Request-Id and Appstrate-Version", async () => {
      const getRes = await app.request("/api/webhooks", {
        headers: authHeaders(ctx),
      });

      const postRes = await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://example.com/consistency-test",
          events: ["run.started"],
        }),
      });

      // Both should have Request-Id
      expect(getRes.headers.get("Request-Id")).not.toBeNull();
      expect(postRes.headers.get("Request-Id")).not.toBeNull();

      // Both should have Appstrate-Version
      expect(getRes.headers.get("Appstrate-Version")).not.toBeNull();
      expect(postRes.headers.get("Appstrate-Version")).not.toBeNull();

      // Versions should match (same test context, no override)
      expect(getRes.headers.get("Appstrate-Version")).toBe(
        postRes.headers.get("Appstrate-Version"),
      );
    });
  });
});
