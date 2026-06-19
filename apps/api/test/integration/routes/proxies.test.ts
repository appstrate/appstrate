// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { db } from "@appstrate/db/client";
import { organizations } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { initSystemProxies } from "../../../src/services/proxy-registry.ts";

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
      // First proxy for the org auto-promotes to the default (org pointer set) —
      // mirrors the org-models first-model-wins behaviour.
      expect(body.is_default).toBe(true);
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
      expect(body.is_default).toBe(true);
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

    it("clears the org default pointer when the default proxy is deleted", async () => {
      // First proxy auto-promotes to default (pointer set).
      const createRes = await app.request("/api/proxies", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Default", url: "http://d.example.com:8080" }),
      });
      const { id } = (await createRes.json()) as any;

      const [before] = await db
        .select({ defaultProxyId: organizations.defaultProxyId })
        .from(organizations)
        .where(eq(organizations.id, ctx.orgId))
        .limit(1);
      expect(before!.defaultProxyId).toBe(id);

      const del = await app.request(`/api/proxies/${id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });
      expect(del.status).toBe(204);

      const [after] = await db
        .select({ defaultProxyId: organizations.defaultProxyId })
        .from(organizations)
        .where(eq(organizations.id, ctx.orgId))
        .limit(1);
      expect(after!.defaultProxyId).toBeNull();
    });
  });

  // The org default proxy is an org-level pointer that may name a SYSTEM proxy id
  // (not just a custom row) — picking any entry makes exactly that one the
  // default ("set default takes over"), same as org-models. Inject a system proxy
  // into the shared registry and restore the empty baseline afterwards.
  describe("PUT /api/proxies/default — system proxy (pointer takes over)", () => {
    const SYSTEM_PROXY_ID = "sys-proxy-default-test";

    beforeEach(() => {
      initSystemProxies([
        { id: SYSTEM_PROXY_ID, label: "System Proxy", url: "http://system.example.com:8080" },
      ]);
    });
    afterEach(() => {
      initSystemProxies(); // restore empty baseline (env is empty in test)
    });

    it("sets a system proxy as the org default and persists the pointer", async () => {
      const res = await app.request("/api/proxies/default", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ proxyId: SYSTEM_PROXY_ID }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe(SYSTEM_PROXY_ID);
      expect(body.is_default).toBe(true);
      expect(body.source).toBe("built-in");

      const [org] = await db
        .select({ defaultProxyId: organizations.defaultProxyId })
        .from(organizations)
        .where(eq(organizations.id, ctx.orgId))
        .limit(1);
      expect(org!.defaultProxyId).toBe(SYSTEM_PROXY_ID);

      const list = await app.request("/api/proxies", { headers: authHeaders(ctx) });
      const proxies = ((await list.json()) as any).data as any[];
      const defaults = proxies.filter((p) => p.is_default);
      expect(defaults).toHaveLength(1);
      expect(defaults[0]!.id).toBe(SYSTEM_PROXY_ID);
    });

    it("rejects an unknown proxy ref", async () => {
      const res = await app.request("/api/proxies/default", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ proxyId: "does-not-exist" }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("Authentication", () => {
    it("returns 401 without auth", async () => {
      const res = await app.request("/api/proxies");
      expect(res.status).toBe(401);
    });
  });
});
