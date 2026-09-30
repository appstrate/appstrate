// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { apiCors, CORS_EXPOSED_HEADERS } from "../../../src/lib/cors.ts";

const ORIGIN = "https://embed.example";

function createApp() {
  const app = new Hono();
  app.use("*", apiCors([ORIGIN]));
  app.get("/api/things", (c) => {
    c.header("Link", '</api/things?cursor=x>; rel="next"');
    return c.json({ data: [] });
  });
  return app;
}

function exposed(res: Response): string[] {
  return (res.headers.get("Access-Control-Expose-Headers") ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

describe("apiCors", () => {
  it("exposes every API response header to a trusted cross-origin caller", async () => {
    const res = await createApp().request("/api/things", { headers: { Origin: ORIGIN } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const list = exposed(res);
    for (const name of CORS_EXPOSED_HEADERS) expect(list).toContain(name.toLowerCase());
    for (const name of ["link", "request-id", "retry-after", "ratelimit", "etag"]) {
      expect(list).toContain(name);
    }
    // Server-to-server proxy headers stay private: no browser calls those routes.
    for (const name of ["x-auth-refreshed", "x-truncated", "x-llm-proxy-cache-status"]) {
      expect(list).not.toContain(name);
    }
  });

  it("answers a preflight for a trusted origin with credentials allowed", async () => {
    const res = await createApp().request("/api/things", {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-org-id",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("grants nothing to an untrusted origin", async () => {
    const res = await createApp().request("/api/things", {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
