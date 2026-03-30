import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../src/types/index.ts";
import { apiVersion } from "../../src/middleware/api-version.ts";
import { CURRENT_API_VERSION } from "../../src/lib/api-versions.ts";
import { requestId } from "../../src/middleware/request-id.ts";
import { errorHandler } from "../../src/middleware/error-handler.ts";

function createApp(getOrgApiVersion?: Parameters<typeof apiVersion>[0]) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use("*", requestId());
  app.use("*", async (c, next) => {
    c.set("user", { id: "u1", email: "test@test.com", name: "Test" });
    c.set("orgId", "org-1");
    return next();
  });
  app.use("*", apiVersion(getOrgApiVersion));
  app.get("/test", (c) => c.json({ version: c.get("apiVersion") }));
  return app;
}

describe("apiVersion middleware", () => {
  it("uses current version when no header sent", async () => {
    const app = createApp();
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    expect(res.headers.get("Appstrate-Version")).toBe(CURRENT_API_VERSION);
    const body = (await res.json()) as { version: string };
    expect(body.version).toBe(CURRENT_API_VERSION);
  });

  it("respects Appstrate-Version header override", async () => {
    const app = createApp();
    const res = await app.request("/test", {
      headers: { "Appstrate-Version": "2026-03-21" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Appstrate-Version")).toBe("2026-03-21");
  });

  it("rejects invalid date format with 400", async () => {
    const app = createApp();
    const res = await app.request("/test", {
      headers: { "Appstrate-Version": "not-a-date" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_api_version");
  });

  it("rejects unsupported version with 400", async () => {
    const app = createApp();
    const res = await app.request("/test", {
      headers: { "Appstrate-Version": "2020-01-01" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("unsupported_api_version");
  });

  it("uses org-pinned version when available", async () => {
    const app = createApp(async () => "2026-03-21");
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    expect(res.headers.get("Appstrate-Version")).toBe("2026-03-21");
  });

  it("falls back to current version when org has no pinned version", async () => {
    const app = createApp(async () => null);
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    expect(res.headers.get("Appstrate-Version")).toBe(CURRENT_API_VERSION);
  });

  it("header takes priority over org-pinned version", async () => {
    const app = createApp(async () => "2026-03-21");
    const res = await app.request("/test", {
      headers: { "Appstrate-Version": "2026-03-21" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Appstrate-Version")).toBe("2026-03-21");
  });

  it("sets apiVersion in context for route handlers", async () => {
    const app = createApp();
    const res = await app.request("/test");
    const body = (await res.json()) as { version: string };
    expect(body.version).toBe(CURRENT_API_VERSION);
  });
});
