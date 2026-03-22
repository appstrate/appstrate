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
import { seedPackage } from "../../helpers/seed.ts";

const app = getTestApp();

describe("Providers API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "provorg" });
  });


  // ─── GET /api/providers ────────────────────────────────────

  describe("GET /api/providers", () => {
    it("returns providers list (may be empty or contain system providers)", async () => {
      const res = await app.request("/api/providers", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.providers).toBeArray();
      expect(body.callbackUrl).toBeString();
    });

    it("returns seeded provider in list", async () => {
      await seedPackage({
        id: "@provorg/my-provider",
        orgId: ctx.orgId,
        type: "provider",
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@provorg/my-provider",
          type: "provider",
          version: "1.0.0",
          displayName: "My Test Provider",
          description: "A test API key provider",
          definition: {
            authMode: "api_key",
            authorizedUris: [],
            allowAllUris: true,
            credentials: {
              schema: {
                type: "object",
                properties: { apiKey: { type: "string" } },
                required: ["apiKey"],
              },
              fieldName: "apiKey",
            },
            credentialHeaderName: "Authorization",
            credentialHeaderPrefix: "Bearer ",
          },
        },
      });

      const res = await app.request("/api/providers", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      const found = body.providers.find((p: { id: string }) => p.id === "@provorg/my-provider");
      expect(found).toBeDefined();
    });

    it("does not leak providers from other orgs", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      await seedPackage({
        id: "@otherorg/secret-provider",
        orgId: otherCtx.orgId,
        type: "provider",
        draftManifest: {
          name: "@otherorg/secret-provider",
          type: "provider",
          version: "1.0.0",
          displayName: "Secret Provider",
          definition: { authMode: "api_key" },
        },
      });

      const res = await app.request("/api/providers", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      const leaked = body.providers.find(
        (p: { id: string }) => p.id === "@otherorg/secret-provider",
      );
      expect(leaked).toBeUndefined();
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/providers");
      expect(res.status).toBe(401);
    });
  });

  // ─── POST /api/providers ───────────────────────────────────

  describe("POST /api/providers", () => {
    it("creates an API key provider (admin)", async () => {
      const res = await app.request("/api/providers", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          id: `@${ctx.org.slug}/new-api-provider`,
          displayName: "New API Provider",
          authMode: "api_key",
          credentialSchema: {
            type: "object",
            properties: { apiKey: { type: "string" } },
            required: ["apiKey"],
          },
          credentialFieldName: "apiKey",
          credentialHeaderName: "X-API-Key",
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.id).toBe(`@${ctx.org.slug}/new-api-provider`);
    });

    it("returns 403 for non-admin users", async () => {
      const memberUser = await createTestUser();
      await addOrgMember(ctx.orgId, memberUser.id, "member");

      const res = await app.request("/api/providers", {
        method: "POST",
        headers: {
          Cookie: memberUser.cookie,
          "X-Org-Id": ctx.orgId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: `@${ctx.org.slug}/blocked-provider`,
          displayName: "Blocked Provider",
          authMode: "api_key",
        }),
      });

      expect(res.status).toBe(403);
    });

    it("returns 400 for invalid body (missing displayName)", async () => {
      const res = await app.request("/api/providers", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          id: `@${ctx.org.slug}/bad-provider`,
          authMode: "api_key",
        }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for duplicate provider ID", async () => {
      // Create first
      await app.request("/api/providers", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          id: `@${ctx.org.slug}/dup-provider`,
          displayName: "Dup Provider",
          authMode: "api_key",
        }),
      });

      // Create again with same ID
      const res = await app.request("/api/providers", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          id: `@${ctx.org.slug}/dup-provider`,
          displayName: "Dup Provider 2",
          authMode: "api_key",
        }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 403 for scope mismatch", async () => {
      const res = await app.request("/api/providers", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          id: "@wrongscope/provider",
          displayName: "Wrong Scope",
          authMode: "api_key",
        }),
      });

      expect(res.status).toBe(403);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "@provorg/no-auth",
          displayName: "No Auth",
          authMode: "api_key",
        }),
      });

      expect(res.status).toBe(401);
    });
  });

  // ─── DELETE /api/providers/:scope/:name ────────────────────

  describe("DELETE /api/providers/:scope/:name", () => {
    it("deletes a custom provider (admin)", async () => {
      // Create via API first
      await app.request("/api/providers", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          id: `@${ctx.org.slug}/to-delete`,
          displayName: "To Delete",
          authMode: "api_key",
        }),
      });

      const res = await app.request(`/api/providers/@${ctx.org.slug}/to-delete`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(204);
    });

    it("returns 403 for non-admin users", async () => {
      // Create provider as admin
      await app.request("/api/providers", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          id: `@${ctx.org.slug}/admin-only-del`,
          displayName: "Admin Only Delete",
          authMode: "api_key",
        }),
      });

      const memberUser = await createTestUser();
      await addOrgMember(ctx.orgId, memberUser.id, "member");

      const res = await app.request(`/api/providers/@${ctx.org.slug}/admin-only-del`, {
        method: "DELETE",
        headers: { Cookie: memberUser.cookie, "X-Org-Id": ctx.orgId },
      });

      expect(res.status).toBe(403);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/providers/@provorg/any-provider", {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
    });
  });

  // ─── PUT /api/providers/:scope/:name ───────────────────────

  describe("PUT /api/providers/:scope/:name", () => {
    it("updates a custom provider (admin)", async () => {
      // Create first
      await app.request("/api/providers", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          id: `@${ctx.org.slug}/to-update`,
          displayName: "Original Name",
          authMode: "api_key",
        }),
      });

      const res = await app.request(`/api/providers/@${ctx.org.slug}/to-update`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          displayName: "Updated Name",
          authMode: "api_key",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.id).toBe(`@${ctx.org.slug}/to-update`);
    });

    it("returns 404 for non-existent provider", async () => {
      const res = await app.request(`/api/providers/@${ctx.org.slug}/nonexistent`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          displayName: "Ghost",
          authMode: "api_key",
        }),
      });

      expect(res.status).toBe(404);
    });

    it("returns 403 for non-admin users", async () => {
      // Create as admin
      await app.request("/api/providers", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          id: `@${ctx.org.slug}/member-update`,
          displayName: "Member Update",
          authMode: "api_key",
        }),
      });

      const memberUser = await createTestUser();
      await addOrgMember(ctx.orgId, memberUser.id, "member");

      const res = await app.request(`/api/providers/@${ctx.org.slug}/member-update`, {
        method: "PUT",
        headers: {
          Cookie: memberUser.cookie,
          "X-Org-Id": ctx.orgId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          displayName: "Updated by member",
          authMode: "api_key",
        }),
      });

      expect(res.status).toBe(403);
    });
  });
});
