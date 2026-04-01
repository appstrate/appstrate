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

  describe("POST /api/api-keys — scopes", () => {
    it("creates key with valid scopes", async () => {
      const res = await app.request("/api/api-keys", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Scoped Key",
          applicationId: ctx.defaultAppId,
          scopes: ["flows:read", "flows:run", "executions:read"],
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.scopes).toBeArray();
      expect(body.scopes).toContain("flows:read");
      expect(body.scopes).toContain("flows:run");
      expect(body.scopes).toContain("executions:read");
    });

    it("creates key without scopes (defaults to all API-key-allowed scopes)", async () => {
      const res = await app.request("/api/api-keys", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Full Access Key",
          applicationId: ctx.defaultAppId,
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.scopes).toBeArray();
      expect(body.scopes.length).toBeGreaterThan(20);
      expect(body.scopes).toContain("flows:read");
      expect(body.scopes).toContain("flows:run");
    });

    it("filters out session-only scopes (org:*, billing:*)", async () => {
      const res = await app.request("/api/api-keys", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Session Scope Key",
          applicationId: ctx.defaultAppId,
          scopes: ["flows:read", "org:delete", "billing:manage", "members:invite"],
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.scopes).toEqual(["flows:read"]);
    });

    it("filters out invalid scope strings", async () => {
      const res = await app.request("/api/api-keys", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Invalid Scope Key",
          applicationId: ctx.defaultAppId,
          scopes: ["flows:read", "not-a-scope", "invalid:permission"],
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.scopes).toEqual(["flows:read"]);
    });

    it("scoped key appears in list with scopes", async () => {
      await app.request("/api/api-keys", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Listed Scoped Key",
          applicationId: ctx.defaultAppId,
          scopes: ["flows:read", "flows:run"],
        }),
      });

      const listRes = await app.request("/api/api-keys", {
        headers: authHeaders(ctx),
      });
      const body = (await listRes.json()) as any;
      expect(body.apiKeys[0].scopes).toContain("flows:read");
      expect(body.apiKeys[0].scopes).toContain("flows:run");
    });
  });

  describe("GET /api/api-keys/available-scopes", () => {
    it("returns scopes for owner", async () => {
      const res = await app.request("/api/api-keys/available-scopes", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.scopes).toBeArray();
      expect(body.scopes.length).toBeGreaterThan(20);
      expect(body.scopes).toContain("flows:read");
      expect(body.scopes).toContain("flows:write");
      expect(body.scopes).toContain("webhooks:write");
      // Session-only scopes should NOT be present
      expect(body.scopes).not.toContain("org:delete");
      expect(body.scopes).not.toContain("billing:manage");
    });

    it("returns 403 for member (api-keys:read is admin-only)", async () => {
      const member = await createTestUser();
      await addOrgMember(ctx.orgId, member.id, "member");
      const memberCtx: TestContext = { ...ctx, user: member, cookie: member.cookie };

      const res = await app.request("/api/api-keys/available-scopes", {
        headers: authHeaders(memberCtx),
      });
      expect(res.status).toBe(403);
    });
  });
});
