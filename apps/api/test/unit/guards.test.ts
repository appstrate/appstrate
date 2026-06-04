// SPDX-License-Identifier: Apache-2.0

/**
 * Guards middleware unit tests.
 *
 * Tests requireMutableAgent which is pure logic (no DB calls). Package mutation is gated by
 * requirePackageInOrg (DB-backed, scope-agnostic) — see the multi-tenancy integration tests
 * and test/integration/routes/packages.test.ts for its coverage.
 */
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import type { AppEnv, LoadedPackage } from "../../src/types/index.ts";
import { requireMutableAgent } from "../../src/middleware/guards.ts";
import { requestId } from "../../src/middleware/request-id.ts";
import { errorHandler } from "../../src/middleware/error-handler.ts";

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use("*", requestId());
  return app;
}

// ─── requireMutableAgent (system agent rejection — no DB call needed) ──

describe("requireMutableAgent", () => {
  it("rejects system agent with 403", async () => {
    const app = createApp();
    app.use("/test", async (c, next) => {
      c.set("package", { id: "@system/agent", source: "system" } as unknown as LoadedPackage);
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
