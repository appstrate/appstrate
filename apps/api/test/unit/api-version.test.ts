// SPDX-License-Identifier: Apache-2.0

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
      headers: { "Appstrate-Version": CURRENT_API_VERSION },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Appstrate-Version")).toBe(CURRENT_API_VERSION);
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
    const body = (await res.json()) as { code: string; param: string };
    expect(body.code).toBe("unsupported_api_version");
    expect(body.param).toBe("Appstrate-Version");
  });

  it("uses org-pinned version when available", async () => {
    const app = createApp(async () => CURRENT_API_VERSION);
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    expect(res.headers.get("Appstrate-Version")).toBe(CURRENT_API_VERSION);
    const body = (await res.json()) as { version: string };
    expect(body.version).toBe(CURRENT_API_VERSION);
  });

  it("rejects a well-formed but unsupported org pin with 400 instead of downgrading", async () => {
    // The org asked to be frozen on a version the server no longer serves.
    // Answering with CURRENT_API_VERSION would deliver a possibly-breaking API
    // under the guise of the pinned one, with nothing in the response saying so.
    const app = createApp(async () => "2020-01-01");
    const res = await app.request("/test");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; param: string; detail: string };
    expect(body.code).toBe("unsupported_api_version");
    expect(body.param).toBe("settings.api_version");
    expect(body.detail).toContain("2020-01-01");
    // The response must not claim to be serving anything.
    expect(res.headers.get("Appstrate-Version")).toBeNull();
  });

  it("rejects a malformed org pin with the same error as an unsupported one", async () => {
    // Deliberately not distinguished from the well-formed-but-dropped case:
    // both are unreadable server state to the caller, with the same remedy.
    const app = createApp(async () => "not-a-date");
    const res = await app.request("/test");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; param: string };
    expect(body.code).toBe("unsupported_api_version");
    expect(body.param).toBe("settings.api_version");
  });

  it("header takes priority over org-pinned version", async () => {
    const app = createApp(async () => CURRENT_API_VERSION);
    const res = await app.request("/test", {
      headers: { "Appstrate-Version": CURRENT_API_VERSION },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Appstrate-Version")).toBe(CURRENT_API_VERSION);
  });

  it("header wins even when the org pin is unsupported", async () => {
    // The header path short-circuits the pin lookup entirely: an org stuck on
    // a dead pin can still be reached by a client that names a live version.
    const app = createApp(async () => "2020-01-01");
    const res = await app.request("/test", {
      headers: { "Appstrate-Version": CURRENT_API_VERSION },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Appstrate-Version")).toBe(CURRENT_API_VERSION);
  });

  it("falls back to current version when org has no pinned version", async () => {
    const app = createApp(async () => null);
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    expect(res.headers.get("Appstrate-Version")).toBe(CURRENT_API_VERSION);
    const body = (await res.json()) as { version: string };
    expect(body.version).toBe(CURRENT_API_VERSION);
  });

  it("falls back to current version when no resolver is wired at all", async () => {
    const app = createApp();
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    expect(res.headers.get("Appstrate-Version")).toBe(CURRENT_API_VERSION);
  });

  it("sets apiVersion in context for route handlers", async () => {
    const app = createApp();
    const res = await app.request("/test");
    const body = (await res.json()) as { version: string };
    expect(body.version).toBe(CURRENT_API_VERSION);
  });
});
