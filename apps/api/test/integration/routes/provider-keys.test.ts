import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestUser, addOrgMember, authHeaders, type TestContext } from "../../helpers/auth.ts";

const app = getTestApp();

describe("Provider Keys API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });


  describe("GET /api/provider-keys", () => {
    it("returns list of provider keys", async () => {
      const res = await app.request("/api/provider-keys", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.keys).toBeArray();
      // May include system provider keys loaded at boot — just verify shape
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/provider-keys");
      expect(res.status).toBe(401);
    });

    it("returns 403 for non-admin member", async () => {
      const member = await createTestUser();
      await addOrgMember(ctx.orgId, member.id, "member");

      const res = await app.request("/api/provider-keys", {
        headers: { Cookie: member.cookie, "X-Org-Id": ctx.orgId },
      });

      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/provider-keys", () => {
    it("creates a provider key", async () => {
      const res = await app.request("/api/provider-keys", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Test Key",
          api: "openai",
          baseUrl: "https://api.openai.com",
          apiKey: "sk-test-key-123",
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.id).toBeDefined();
      expect(typeof body.id).toBe("string");
    });

    it("returns 403 for non-admin member", async () => {
      const member = await createTestUser();
      await addOrgMember(ctx.orgId, member.id, "member");

      const res = await app.request("/api/provider-keys", {
        method: "POST",
        headers: {
          Cookie: member.cookie,
          "X-Org-Id": ctx.orgId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          label: "Test Key",
          api: "openai",
          baseUrl: "https://api.openai.com",
          apiKey: "sk-test-key-123",
        }),
      });

      expect(res.status).toBe(403);
    });
  });

  describe("PUT /api/provider-keys/:id", () => {
    it("updates provider key label", async () => {
      // Create a provider key first
      const createRes = await app.request("/api/provider-keys", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Original Label",
          api: "openai",
          baseUrl: "https://api.openai.com",
          apiKey: "sk-test-key-123",
        }),
      });
      expect(createRes.status).toBe(201);
      const { id } = await createRes.json() as any;

      // Update the label
      const res = await app.request(`/api/provider-keys/${id}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ label: "Updated Label" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.id).toBe(id);
    });
  });

  describe("DELETE /api/provider-keys/:id", () => {
    it("deletes a provider key and returns 204", async () => {
      // Create a provider key first
      const createRes = await app.request("/api/provider-keys", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "To Delete",
          api: "openai",
          baseUrl: "https://api.openai.com",
          apiKey: "sk-test-key-123",
        }),
      });
      expect(createRes.status).toBe(201);
      const { id } = await createRes.json() as any;

      // Delete it
      const res = await app.request(`/api/provider-keys/${id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(204);

      // Verify it is gone
      const listRes = await app.request("/api/provider-keys", {
        headers: authHeaders(ctx),
      });
      const body = await listRes.json() as any;
      const found = body.keys.find((k: { id: string }) => k.id === id);
      expect(found).toBeUndefined();
    });
  });
});
