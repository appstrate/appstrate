import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";

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
      const body = await res.json() as any;
      expect(body.object).toBe("list");
      expect(body.data).toBeArray();
      expect(body.data.length).toBeGreaterThanOrEqual(1);

      const defaultApp = body.data.find(
        (a: { id: string }) => a.id === ctx.defaultAppId,
      );
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
      const body = await res.json() as any;
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
      const body = await res.json() as any;
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
      const created = await createRes.json() as any;

      const res = await app.request(`/api/applications/${created.id}`, {
        method: "PATCH",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated Name" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
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
      const created = await createRes.json() as any;

      const res = await app.request(`/api/applications/${created.id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(204);

      // Verify it is gone from the list
      const listRes = await app.request("/api/applications", {
        headers: authHeaders(ctx),
      });
      const listBody = await listRes.json() as any;
      const found = listBody.data.find(
        (a: { id: string }) => a.id === created.id,
      );
      expect(found).toBeUndefined();
    });
  });
});
