import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestUser, addOrgMember, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedFlow } from "../../helpers/seed.ts";

const app = getTestApp();

describe("User Flows API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
  });


  describe("DELETE /api/packages/flows/:scope/:name", () => {
    // NOTE: DELETE flow calls S3 to remove artifacts — returns 500 without real S3.
    // These tests verify auth/guard behavior only. Full delete tests require MinIO.
    it("returns 401 without auth on delete", async () => {
      const res = await app.request("/api/packages/flows/@myorg/some-flow", {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
    });

    it("returns 403 for non-admin member", async () => {
      await seedFlow({
        id: "@myorg/admin-only",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const member = await createTestUser();
      await addOrgMember(ctx.orgId, member.id, "member");

      const res = await app.request("/api/packages/flows/@myorg/admin-only", {
        method: "DELETE",
        headers: { Cookie: member.cookie, "X-Org-Id": ctx.orgId },
      });

      expect(res.status).toBe(403);
    });
  });

  describe("PUT /api/flows/:scope/:name/skills", () => {
    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/flows/@myorg/test-flow/skills", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillIds: [] }),
      });

      expect(res.status).toBe(401);
    });

    it("returns 404 for non-existent flow", async () => {
      const res = await app.request("/api/flows/@myorg/nonexistent/skills", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ skillIds: [] }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/flows/:scope/:name/tools", () => {
    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/flows/@myorg/test-flow/tools", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolIds: [] }),
      });

      expect(res.status).toBe(401);
    });

    it("returns 404 for non-existent flow", async () => {
      const res = await app.request("/api/flows/@myorg/nonexistent/tools", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ toolIds: [] }),
      });

      expect(res.status).toBe(404);
    });
  });
});
