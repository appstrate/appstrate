/**
 * Systematic error-path tests for all routes.
 *
 * Validates that all authenticated routes return 401 without auth,
 * and resource routes return 404 for non-existent resources.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";

const app = getTestApp();

// ─── 401 Unauthorized: all auth-required routes ─────────────

describe("401 — unauthenticated requests", () => {
  const authRequiredRoutes = [
    { method: "GET", path: "/api/flows" },
    { method: "GET", path: "/api/api-keys" },
    { method: "POST", path: "/api/api-keys" },
    { method: "GET", path: "/api/providers" },
    { method: "GET", path: "/api/applications" },
    { method: "POST", path: "/api/applications" },
    { method: "GET", path: "/api/end-users" },
    { method: "GET", path: "/api/webhooks" },
    { method: "POST", path: "/api/webhooks" },
    { method: "GET", path: "/api/models" },
    { method: "GET", path: "/api/proxies" },
    { method: "POST", path: "/api/proxies" },
    { method: "GET", path: "/api/provider-keys" },
    { method: "GET", path: "/api/connection-profiles" },
    { method: "GET", path: "/api/notifications" },
    { method: "GET", path: "/api/packages" },
  ];

  for (const route of authRequiredRoutes) {
    it(`${route.method} ${route.path} returns 401`, async () => {
      const res = await app.request(route.path, { method: route.method });
      expect(res.status).toBe(401);
      const body = (await res.json()) as any;
      expect(body.code).toBe("unauthorized");
    });
  }
});

// ─── 400 — missing X-Org-Id header ─────────────────────────

describe("400 — missing X-Org-Id header on org-scoped routes", () => {
  let cookie: string;

  beforeEach(async () => {
    await truncateAll();
    const user = await createTestUser();
    cookie = user.cookie;
  });

  const orgScopedRoutes = [
    { method: "GET", path: "/api/flows" },
    { method: "GET", path: "/api/api-keys" },
    { method: "GET", path: "/api/providers" },
    { method: "GET", path: "/api/applications" },
    { method: "GET", path: "/api/webhooks" },
    { method: "GET", path: "/api/models" },
    { method: "GET", path: "/api/proxies" },
    { method: "GET", path: "/api/provider-keys" },
    { method: "GET", path: "/api/packages" },
  ];

  for (const route of orgScopedRoutes) {
    it(`${route.method} ${route.path} returns 400 without X-Org-Id`, async () => {
      const res = await app.request(route.path, {
        method: route.method,
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.code).toBe("invalid_request");
      expect(body.param).toBe("X-Org-Id");
    });
  }
});

// ─── 404 — non-existent resources ───────────────────────────

describe("404 — non-existent resources", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  it("GET /api/flows/@testorg/nonexistent/config returns 404", async () => {
    const res = await app.request("/api/flows/@testorg/nonexistent/config", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /api/api-keys/nonexistent returns 404", async () => {
    const res = await app.request("/api/api-keys/nonexistent", {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /api/webhooks/nonexistent returns 404", async () => {
    const res = await app.request("/api/webhooks/nonexistent", {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /api/applications/nonexistent returns 404", async () => {
    const res = await app.request("/api/applications/nonexistent", {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/end-users/nonexistent returns 404", async () => {
    const res = await app.request("/api/end-users/nonexistent", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });
});

// ─── 403 — cross-org access ────────────────────────────────

describe("403 — cross-org access prevention", () => {
  let ctxA: TestContext;
  let ctxB: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctxA = await createTestContext({ orgSlug: "orga" });
    ctxB = await createTestContext({ orgSlug: "orgb" });
  });

  it("user from org A cannot access org B resources", async () => {
    // Create a flow in org B
    await seedPackage({ id: "@orgb/secret-flow", orgId: ctxB.orgId });

    // User A tries to access org B's flows by using org B's ID
    const res = await app.request("/api/flows", {
      headers: {
        Cookie: ctxA.cookie,
        "X-Org-Id": ctxB.orgId,
      },
    });
    // Should be 403 because ctxA user is not a member of org B
    expect(res.status).toBe(403);
  });

  it("user cannot modify another org's packages", async () => {
    await seedPackage({ id: "@orgb/their-flow", orgId: ctxB.orgId });

    // User A tries to update org B's flow config
    const res = await app.request("/api/flows/@orgb/their-flow/config", {
      method: "PUT",
      headers: {
        ...authHeaders(ctxA),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    // Should be 403 or 404 (can't see other org's flows)
    expect([403, 404]).toContain(res.status);
  });
});

// ─── Public routes work without auth ────────────────────────

describe("public routes — no auth required", () => {
  it("GET /health returns 200 without auth", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("GET /health includes required fields", async () => {
    const res = await app.request("/health");
    const body = (await res.json()) as any;
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("uptime_ms");
    expect(body).toHaveProperty("checks");
  });
});

// ─── Validation errors ──────────────────────────────────────

describe("400 — validation errors", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  it("POST /api/api-keys without body returns 400", async () => {
    const res = await app.request("/api/api-keys", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/webhooks with invalid URL returns 400", async () => {
    const res = await app.request("/api/webhooks", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "not-a-valid-url",
        events: ["execution.completed"],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/applications without name returns 400", async () => {
    const res = await app.request("/api/applications", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ─── RFC 9457 response format ───────────────────────────────

describe("RFC 9457 — problem detail format on errors", () => {
  it("returns application/problem+json content type", async () => {
    const res = await app.request("/api/flows"); // no auth
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("application/problem+json");
  });

  it("includes all required RFC 9457 fields", async () => {
    const res = await app.request("/api/flows"); // no auth
    const body = (await res.json()) as any;

    expect(body).toHaveProperty("type");
    expect(body).toHaveProperty("title");
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("detail");
    expect(body).toHaveProperty("instance");
    expect(body).toHaveProperty("code");
    expect(body).toHaveProperty("requestId");
  });

  it("includes Request-Id header matching body", async () => {
    const res = await app.request("/api/flows");
    const body = (await res.json()) as any;
    const headerReqId = res.headers.get("Request-Id");
    expect(headerReqId).toBe(body.requestId);
  });

  it("type URI follows kebab-case convention", async () => {
    const res = await app.request("/api/flows");
    const body = (await res.json()) as any;
    expect(body.type).toMatch(/^https:\/\/docs\.appstrate\.dev\/errors\/[a-z-]+$/);
  });
});
