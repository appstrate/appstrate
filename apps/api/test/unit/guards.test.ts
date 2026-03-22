/**
 * Guards middleware unit tests.
 *
 * Tests requireAdmin, requireOwnedPackage, and checkScopeMatch which are pure
 * logic (no DB calls). For requireFlow and requireMutableFlow which depend on
 * DB-backed services, see test/integration/middleware/guards-integration.test.ts.
 */
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import type { AppEnv, LoadedFlow } from "../../src/types/index.ts";
import { requireAdmin, requireOwnedPackage, checkScopeMatch, requireMutableFlow } from "../../src/middleware/guards.ts";
import { requestId } from "../../src/middleware/request-id.ts";
import { errorHandler } from "../../src/middleware/error-handler.ts";

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use("*", requestId());
  return app;
}

// ─── requireAdmin ───────────────────────────────────────────

describe("requireAdmin", () => {
  it("allows owner role", async () => {
    const app = createApp();
    app.use("/test", async (c, next) => {
      c.set("orgRole", "owner");
      return requireAdmin()(c, next);
    });
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });

  it("allows admin role", async () => {
    const app = createApp();
    app.use("/test", async (c, next) => {
      c.set("orgRole", "admin");
      return requireAdmin()(c, next);
    });
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });

  it("rejects member role with 403", async () => {
    const app = createApp();
    app.use("/test", async (c, next) => {
      c.set("orgRole", "member");
      return requireAdmin()(c, next);
    });
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.code).toBe("forbidden");
    expect(body.detail).toContain("Admin");
  });

  it("rejects undefined role with 403", async () => {
    const app = createApp();
    app.use("/test", async (c, next) => {
      return requireAdmin()(c, next);
    });
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(403);
  });
});

// ─── requireOwnedPackage ────────────────────────────────────

describe("requireOwnedPackage", () => {
  it("allows when package scope matches org slug", async () => {
    const app = createApp();
    app.use("/:scope{@[^/]+}/:name", async (c, next) => {
      c.set("orgSlug", "myorg");
      return requireOwnedPackage()(c, next);
    });
    app.get("/:scope{@[^/]+}/:name", (c) => c.json({ ok: true }));

    const res = await app.request("/@myorg/my-flow");
    expect(res.status).toBe(200);
  });

  it("rejects when package scope does not match org slug", async () => {
    const app = createApp();
    app.use("/:scope{@[^/]+}/:name", async (c, next) => {
      c.set("orgSlug", "myorg");
      return requireOwnedPackage()(c, next);
    });
    app.get("/:scope{@[^/]+}/:name", (c) => c.json({ ok: true }));

    const res = await app.request("/@otherorg/my-flow");
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.code).toBe("forbidden");
    expect(body.detail).toContain("Fork");
  });
});

// ─── checkScopeMatch ────────────────────────────────────────

describe("checkScopeMatch", () => {
  it("returns null when scope matches", () => {
    const mockContext = { get: (key: string) => (key === "orgSlug" ? "myorg" : undefined) } as any;
    const result = checkScopeMatch(mockContext, "@myorg/my-flow");
    expect(result).toBeNull();
  });

  it("returns ApiError when scope does not match", () => {
    const mockContext = { get: (key: string) => (key === "orgSlug" ? "myorg" : undefined) } as any;
    const result = checkScopeMatch(mockContext, "@otherorg/my-flow");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    expect(result!.code).toBe("scope_mismatch");
  });
});

// ─── requireMutableFlow (system flow rejection — no DB call needed) ──

describe("requireMutableFlow", () => {
  it("rejects system flow with 403", async () => {
    const app = createApp();
    app.use("/test", async (c, next) => {
      c.set("flow", { id: "@system/flow", source: "system" } as unknown as LoadedFlow);
      return requireMutableFlow()(c, next);
    });
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.code).toBe("forbidden");
    expect(body.detail).toContain("system");
  });
});
