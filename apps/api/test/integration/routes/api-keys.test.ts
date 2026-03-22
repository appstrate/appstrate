import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  addOrgMember,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";

const app = getTestApp();

describe("API Keys API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });


  describe("GET /api/api-keys", () => {
    it("returns empty list when no keys exist", async () => {
      const res = await app.request("/api/api-keys", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.apiKeys).toBeArray();
      expect(body.apiKeys).toHaveLength(0);
    });

    it("returns keys after creation", async () => {
      // Create a key first
      await app.request("/api/api-keys", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Key",
          applicationId: ctx.defaultAppId,
        }),
      });

      const res = await app.request("/api/api-keys", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.apiKeys).toHaveLength(1);
      expect(body.apiKeys[0].name).toBe("Test Key");
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/api-keys");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/api-keys", () => {
    it("creates an API key with name and applicationId", async () => {
      const res = await app.request("/api/api-keys", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "My API Key",
          applicationId: ctx.defaultAppId,
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.id).toBeDefined();
      expect(body.key).toBeDefined();
      expect(body.keyPrefix).toBeDefined();
    });

    it("created key has ask_ prefix", async () => {
      const res = await app.request("/api/api-keys", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Prefixed Key",
          applicationId: ctx.defaultAppId,
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.key).toStartWith("ask_");
      expect(body.keyPrefix).toStartWith("ask_");
    });

    it("returns 403 for non-admin member", async () => {
      const member = await createTestUser({ email: "member@test.com" });
      await addOrgMember(ctx.orgId, member.id, "member");

      const res = await app.request("/api/api-keys", {
        method: "POST",
        headers: {
          Cookie: member.cookie,
          "X-Org-Id": ctx.orgId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Forbidden Key",
          applicationId: ctx.defaultAppId,
        }),
      });

      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /api/api-keys/:id", () => {
    it("deletes an API key and returns 204", async () => {
      // Create a key
      const createRes = await app.request("/api/api-keys", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "To Delete",
          applicationId: ctx.defaultAppId,
        }),
      });
      const { id } = await createRes.json() as any;

      // Delete it
      const deleteRes = await app.request(`/api/api-keys/${id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(deleteRes.status).toBe(204);
    });

    it("deleted key no longer appears in list", async () => {
      // Create a key
      const createRes = await app.request("/api/api-keys", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Ephemeral Key",
          applicationId: ctx.defaultAppId,
        }),
      });
      const { id } = await createRes.json() as any;

      // Delete it
      await app.request(`/api/api-keys/${id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      // Verify it is gone
      const listRes = await app.request("/api/api-keys", {
        headers: authHeaders(ctx),
      });
      const body = await listRes.json() as any;
      const found = body.apiKeys.find((k: { id: string }) => k.id === id);
      expect(found).toBeUndefined();
    });
  });
});
