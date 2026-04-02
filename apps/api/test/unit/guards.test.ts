// SPDX-License-Identifier: Apache-2.0

/**
 * Guards middleware unit tests.
 *
 * Tests requireOwnedPackage, checkScopeMatch, and requireMutableAgent which are
 * pure logic (no DB calls). For requireAgent which depends on DB-backed services,
 * see test/integration/middleware/guards-integration.test.ts.
 */
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import type { AppEnv, LoadedPackage } from "../../src/types/index.ts";
import {
  requireOwnedPackage,
  checkScopeMatch,
  requireMutableAgent,
} from "../../src/middleware/guards.ts";
import { requestId } from "../../src/middleware/request-id.ts";
import { errorHandler } from "../../src/middleware/error-handler.ts";

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use("*", requestId());
  return app;
}

// ─── requireOwnedPackage ────────────────────────────────────

describe("requireOwnedPackage", () => {
  it("allows when package scope matches org slug", async () => {
    const app = createApp();
    app.use("/:scope{@[^/]+}/:name", async (c, next) => {
      c.set("orgSlug", "myorg");
      return requireOwnedPackage()(c, next);
    });
    app.get("/:scope{@[^/]+}/:name", (c) => c.json({ ok: true }));

    const res = await app.request("/@myorg/my-agent");
    expect(res.status).toBe(200);
  });

  it("rejects when package scope does not match org slug", async () => {
    const app = createApp();
    app.use("/:scope{@[^/]+}/:name", async (c, next) => {
      c.set("orgSlug", "myorg");
      return requireOwnedPackage()(c, next);
    });
    app.get("/:scope{@[^/]+}/:name", (c) => c.json({ ok: true }));

    const res = await app.request("/@otherorg/my-agent");
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
    const result = checkScopeMatch(mockContext, "@myorg/my-agent");
    expect(result).toBeNull();
  });

  it("returns ApiError when scope does not match", () => {
    const mockContext = { get: (key: string) => (key === "orgSlug" ? "myorg" : undefined) } as any;
    const result = checkScopeMatch(mockContext, "@otherorg/my-agent");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    expect(result!.code).toBe("scope_mismatch");
  });
});

// ─── requireMutableAgent (system agent rejection — no DB call needed) ──

describe("requireMutableAgent", () => {
  it("rejects system agent with 403", async () => {
    const app = createApp();
    app.use("/test", async (c, next) => {
      c.set("agent", { id: "@system/agent", source: "system" } as unknown as LoadedPackage);
      return requireMutableAgent()(c, next);
    });
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.code).toBe("forbidden");
    expect(body.detail).toContain("system");
  });
});
