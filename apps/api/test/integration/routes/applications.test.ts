// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedApiKey, seedApplication } from "../../helpers/seed.ts";
import { applications } from "@appstrate/db/schema";

const app = getTestApp();

describe("Applications API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  describe("GET /api/applications", () => {
    it("lists applications including the default app from createTestContext", async () => {
      const res = await app.request("/api/applications", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.object).toBe("list");
      expect(body.data).toBeArray();
      expect(body.data.length).toBeGreaterThanOrEqual(1);

      const defaultApp = body.data.find((a: { id: string }) => a.id === ctx.defaultAppId);
      expect(defaultApp).toBeDefined();
      expect(defaultApp.object).toBe("application");
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/applications");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/applications", () => {
    it("creates an application", async () => {
      const res = await app.request("/api/applications", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "My New App" }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.object).toBe("application");
      expect(body.name).toBe("My New App");
      expect(body.id).toBeDefined();
    });
  });

  describe("GET /api/applications/:id", () => {
    it("returns an application by ID", async () => {
      const res = await app.request(`/api/applications/${ctx.defaultAppId}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.object).toBe("application");
      expect(body.id).toBe(ctx.defaultAppId);
    });
  });

  describe("PATCH /api/applications/:id", () => {
    it("updates application name", async () => {
      // Create a non-default app to update
      const createRes = await app.request("/api/applications", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Original Name" }),
      });
      const created = (await createRes.json()) as any;

      const res = await app.request(`/api/applications/${created.id}`, {
        method: "PATCH",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated Name" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.object).toBe("application");
      expect(body.name).toBe("Updated Name");
    });
  });

  describe("DELETE /api/applications/:id", () => {
    it("deletes an application and returns 204", async () => {
      // Create a non-default app to delete
      const createRes = await app.request("/api/applications", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "To Delete" }),
      });
      const created = (await createRes.json()) as any;

      const res = await app.request(`/api/applications/${created.id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(204);

      // Verify it is gone from the list
      const listRes = await app.request("/api/applications", {
        headers: authHeaders(ctx),
      });
      const listBody = (await listRes.json()) as any;
      const found = listBody.data.find((a: { id: string }) => a.id === created.id);
      expect(found).toBeUndefined();
    });
  });

  // Issue #172 (extension) — API keys are application-scoped, but the
  // applications router only filtered by orgId. A key bound to App A could
  // therefore enumerate, read, mutate, and delete every App B in the same
  // org. These tests pin the cross-app surface.
  describe("API key application scope (issue #172 extension)", () => {
    async function setupTwoAppKey() {
      const sharedCtx = await createTestContext({ orgSlug: "appscope-172" });
      const otherApp = await seedApplication({
        orgId: sharedCtx.orgId,
        name: "Other App",
      });
      const apiKey = await seedApiKey({
        orgId: sharedCtx.orgId,
        applicationId: sharedCtx.defaultAppId,
        createdBy: sharedCtx.user.id,
        scopes: [
          "applications:read",
          "applications:write",
          "applications:delete",
          "providers:write",
        ],
      });
      return {
        ctx: sharedCtx,
        otherAppId: otherApp.id,
        bearer: { Authorization: `Bearer ${apiKey.rawKey}` },
      };
    }

    it("GET /api/applications returns only the key's app", async () => {
      const { ctx, otherAppId, bearer } = await setupTwoAppKey();
      const res = await app.request("/api/applications", { headers: bearer });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string }[] };
      const ids = body.data.map((a) => a.id);
      expect(ids).toContain(ctx.defaultAppId);
      expect(ids).not.toContain(otherAppId);
      expect(body.data).toHaveLength(1);
    });

    it("GET /api/applications/:otherAppId returns 403", async () => {
      const { otherAppId, bearer } = await setupTwoAppKey();
      const res = await app.request(`/api/applications/${otherAppId}`, { headers: bearer });
      expect(res.status).toBe(403);
    });

    it("PATCH /api/applications/:otherAppId returns 403 and does not mutate", async () => {
      const { otherAppId, bearer } = await setupTwoAppKey();
      const res = await app.request(`/api/applications/${otherAppId}`, {
        method: "PATCH",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "PWNED" }),
      });
      expect(res.status).toBe(403);
      const [row] = await db
        .select({ name: applications.name })
        .from(applications)
        .where(eq(applications.id, otherAppId));
      expect(row?.name).not.toBe("PWNED");
    });

    it("DELETE /api/applications/:otherAppId returns 403 and app survives", async () => {
      const { otherAppId, bearer } = await setupTwoAppKey();
      const res = await app.request(`/api/applications/${otherAppId}`, {
        method: "DELETE",
        headers: bearer,
      });
      expect(res.status).toBe(403);
      const rows = await db
        .select({ id: applications.id })
        .from(applications)
        .where(eq(applications.id, otherAppId));
      expect(rows).toHaveLength(1);
    });

    it("POST /api/applications returns 403 — API keys cannot create apps", async () => {
      const { bearer } = await setupTwoAppKey();
      const res = await app.request("/api/applications", {
        method: "POST",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Pwn App" }),
      });
      expect(res.status).toBe(403);
    });

    it("POST /api/applications/:otherAppId/packages returns 403", async () => {
      const { otherAppId, bearer } = await setupTwoAppKey();
      const res = await app.request(`/api/applications/${otherAppId}/packages`, {
        method: "POST",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: "@x/y" }),
      });
      expect(res.status).toBe(403);
    });

    it("PUT /api/applications/:otherAppId/providers/:p/credentials returns 403", async () => {
      const { otherAppId, bearer } = await setupTwoAppKey();
      const res = await app.request(
        `/api/applications/${otherAppId}/providers/@scope/prov/credentials`,
        {
          method: "PUT",
          headers: { ...bearer, "Content-Type": "application/json" },
          body: JSON.stringify({ credentials: { apiKey: "secret" } }),
        },
      );
      expect(res.status).toBe(403);
    });

    it("DELETE /api/applications/:keyAppId is allowed (own scope)", async () => {
      const { ctx, bearer } = await setupTwoAppKey();
      // Just confirm the guard does not block — actual delete may 4xx for
      // default-app constraints, but it must not be 403 from the guard.
      const res = await app.request(`/api/applications/${ctx.defaultAppId}`, {
        method: "DELETE",
        headers: bearer,
      });
      expect(res.status).not.toBe(403);
    });
  });
});
