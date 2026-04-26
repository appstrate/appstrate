// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";

const app = getTestApp();

describe("Proxies API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  describe("GET /api/proxies", () => {
    it("returns proxy list", async () => {
      const res = await app.request("/api/proxies", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toBeArray();
    });
  });

  describe("POST /api/proxies", () => {
    it("creates a proxy", async () => {
      const res = await app.request("/api/proxies", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          label: "Test Proxy",
          url: "http://proxy.example.com:8080",
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.id).toBeTruthy();
    });
  });

  describe("DELETE /api/proxies/:id", () => {
    it("deletes a custom proxy", async () => {
      // Create first
      const createRes = await app.request("/api/proxies", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          label: "To Delete",
          url: "http://delete-me.example.com:8080",
        }),
      });
      const { id } = (await createRes.json()) as any;

      const res = await app.request(`/api/proxies/${id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("returns 401 without auth", async () => {
      const res = await app.request("/api/proxies");
      expect(res.status).toBe(401);
    });
  });
});
