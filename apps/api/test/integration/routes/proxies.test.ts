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
    it("creates a proxy and returns the full resource", async () => {
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
      // Bare resource — same shape as the GET list serializer (#657).
      expect(body.id).toBeTruthy();
      expect(body.label).toBe("Test Proxy");
      expect(body.source).toBe("custom");
      expect(body.enabled).toBe(true);
      expect(body.isDefault).toBe(false);
      expect(body.urlPrefix).toBeTruthy();
      expect(body.createdAt).toBeTruthy();
      expect(body.updatedAt).toBeTruthy();
    });
  });

  describe("PUT /api/proxies/:id", () => {
    it("updates a proxy and returns the full resource", async () => {
      const createRes = await app.request("/api/proxies", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          label: "Before",
          url: "http://before.example.com:8080",
        }),
      });
      const { id } = (await createRes.json()) as any;

      const res = await app.request(`/api/proxies/${id}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ label: "After", enabled: false }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      // Bare updated resource (#657).
      expect(body.id).toBe(id);
      expect(body.label).toBe("After");
      expect(body.enabled).toBe(false);
      expect(body.source).toBe("custom");
      expect(body.updatedAt).toBeTruthy();
    });
  });

  describe("PUT /api/proxies/default", () => {
    it("sets the default proxy and returns the affected resource", async () => {
      const createRes = await app.request("/api/proxies", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          label: "Default Candidate",
          url: "http://default.example.com:8080",
        }),
      });
      const { id } = (await createRes.json()) as any;

      const res = await app.request("/api/proxies/default", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ proxyId: id }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      // Bare effective default proxy resource — no `success` envelope (#657).
      expect(body.success).toBeUndefined();
      expect(body.id).toBe(id);
      expect(body.isDefault).toBe(true);
      expect(body.label).toBe("Default Candidate");
    });

    it("returns 204 when unsetting the default and none remains in effect", async () => {
      const res = await app.request("/api/proxies/default", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ proxyId: null }),
      });

      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
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
