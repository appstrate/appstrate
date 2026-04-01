import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedFlow, seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { assertDbMissing, assertDbHas } from "../../helpers/assertions.ts";
import { packages } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";

const app = getTestApp();

describe("Packages API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "pkgorg" });
  });

  // ═══════════════════════════════════════════════
  // GET /api/packages/flows — list flows
  // ═══════════════════════════════════════════════

  describe("GET /api/packages/flows", () => {
    it("returns empty list when no flows exist", async () => {
      const res = await app.request("/api/packages/flows", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.flows).toBeArray();
      expect(body.flows).toHaveLength(0);
    });

    it("returns flows owned by the org", async () => {
      await seedFlow({
        id: "@pkgorg/list-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/flows", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const flow = body.flows.find((f: { id: string }) => f.id === "@pkgorg/list-flow");
      expect(flow).toBeDefined();
    });

    it("does not leak flows from other orgs", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      await seedFlow({
        id: "@otherorg/secret-flow",
        orgId: otherCtx.orgId,
        createdBy: otherCtx.user.id,
      });

      const res = await app.request("/api/packages/flows", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const leaked = body.flows.find((f: { id: string }) => f.id === "@otherorg/secret-flow");
      expect(leaked).toBeUndefined();
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/packages/flows");
      expect(res.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════
  // GET /api/packages/skills — list skills
  // ═══════════════════════════════════════════════

  describe("GET /api/packages/skills", () => {
    it("returns empty list when no skills exist", async () => {
      const res = await app.request("/api/packages/skills", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.skills).toBeArray();
    });

    it("returns seeded skill", async () => {
      await seedPackage({
        id: "@pkgorg/my-skill",
        orgId: ctx.orgId,
        type: "skill",
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@pkgorg/my-skill",
          version: "0.1.0",
          type: "skill",
          description: "A test skill",
        },
        draftContent: "# My Skill\nDo something useful.",
      });

      const res = await app.request("/api/packages/skills", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const skill = body.skills.find((s: { id: string }) => s.id === "@pkgorg/my-skill");
      expect(skill).toBeDefined();
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/packages/skills");
      expect(res.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════
  // GET /api/packages/flows/:scope/:name — flow detail
  // ═══════════════════════════════════════════════

  describe("GET /api/packages/flows/:scope/:name", () => {
    it("returns flow detail with version count", async () => {
      await seedFlow({
        id: "@pkgorg/detail-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/flows/@pkgorg/detail-flow", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.flow).toBeDefined();
      expect(body.flow.id).toBe("@pkgorg/detail-flow");
    });

    it("returns 404 for non-existent package", async () => {
      const res = await app.request("/api/packages/flows/@pkgorg/does-not-exist", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 404 for package from another org", async () => {
      const otherCtx = await createTestContext({ orgSlug: "alien" });
      await seedFlow({
        id: "@alien/private-flow",
        orgId: otherCtx.orgId,
        createdBy: otherCtx.user.id,
      });

      const res = await app.request("/api/packages/flows/@alien/private-flow", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/packages/flows/@pkgorg/detail-flow");
      expect(res.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════
  // GET /api/packages/skills/:scope/:name — skill detail
  // ═══════════════════════════════════════════════

  describe("GET /api/packages/skills/:scope/:name", () => {
    it("returns skill detail", async () => {
      await seedPackage({
        id: "@pkgorg/detail-skill",
        orgId: ctx.orgId,
        type: "skill",
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@pkgorg/detail-skill",
          version: "0.1.0",
          type: "skill",
          description: "Skill detail test",
        },
        draftContent: "# Detail Skill",
      });

      const res = await app.request("/api/packages/skills/@pkgorg/detail-skill", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.skill).toBeDefined();
      expect(body.skill.id).toBe("@pkgorg/detail-skill");
    });

    it("returns 404 for non-existent skill", async () => {
      const res = await app.request("/api/packages/skills/@pkgorg/nope", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════
  // POST /api/packages/flows — create flow (admin only)
  // ═══════════════════════════════════════════════

  describe("POST /api/packages/flows", () => {
    it("creates a flow with valid manifest and content", async () => {
      const res = await app.request("/api/packages/flows", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: `@pkgorg/new-flow`,
            version: "0.1.0",
            type: "flow",
            schemaVersion: "1.0",
            displayName: "New Flow",
            description: "A brand new flow",
          },
          content: "You are a helpful assistant.",
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.packageId).toBe("@pkgorg/new-flow");
      expect(body.lockVersion).toBeNumber();

      await assertDbHas(packages, eq(packages.id, "@pkgorg/new-flow"));
    });

    it("returns 400 when content is empty", async () => {
      const res = await app.request("/api/packages/flows", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: `@pkgorg/empty-content`,
            version: "0.1.0",
            type: "flow",
            schemaVersion: "1.0",
            displayName: "Empty Content",
            description: "Empty content test",
          },
          content: "   ",
        }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for duplicate package name", async () => {
      await seedFlow({
        id: "@pkgorg/dup-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/flows", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: "@pkgorg/dup-flow",
            version: "0.1.0",
            type: "flow",
            schemaVersion: "1.0",
            displayName: "Dup Flow",
            description: "Duplicate",
          },
          content: "duplicate prompt",
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.code).toBe("name_collision");
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/packages/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          manifest: {
            name: "@pkgorg/unauth-flow",
            version: "0.1.0",
            type: "flow",
            schemaVersion: "1.0",
            displayName: "Unauth Flow",
            description: "No auth",
          },
          content: "no auth prompt",
        }),
      });

      expect(res.status).toBe(401);
    });

    it("returns 403 when scope does not match org", async () => {
      const res = await app.request("/api/packages/flows", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: "@wrongorg/mismatched-flow",
            version: "0.1.0",
            type: "flow",
            schemaVersion: "1.0",
            displayName: "Mismatched Flow",
            description: "Wrong scope",
          },
          content: "wrong scope prompt",
        }),
      });

      expect(res.status).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════
  // PUT /api/packages/flows/:scope/:name — update flow (admin only)
  // ═══════════════════════════════════════════════

  describe("PUT /api/packages/flows/:scope/:name", () => {
    it("updates a flow with valid manifest and lockVersion", async () => {
      const flow = await seedFlow({
        id: "@pkgorg/update-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/flows/@pkgorg/update-flow", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: "@pkgorg/update-flow",
            version: "0.2.0",
            type: "flow",
            schemaVersion: "1.0",
            displayName: "Update Flow",
            description: "Updated flow",
          },
          content: "Updated prompt content.",
          lockVersion: flow.lockVersion,
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.packageId).toBe("@pkgorg/update-flow");
      expect(body.lockVersion).toBeGreaterThan(flow.lockVersion!);
    });

    it("returns 400 when lockVersion is missing", async () => {
      await seedFlow({
        id: "@pkgorg/no-lock-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/flows/@pkgorg/no-lock-flow", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: "@pkgorg/no-lock-flow",
            version: "0.2.0",
            type: "flow",
            schemaVersion: "1.0",
            displayName: "No Lock Flow",
            description: "No lockVersion",
          },
          content: "content",
        }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent flow", async () => {
      const res = await app.request("/api/packages/flows/@pkgorg/ghost-flow", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: "@pkgorg/ghost-flow",
            version: "0.1.0",
            type: "flow",
            schemaVersion: "1.0",
            displayName: "Ghost Flow",
            description: "Ghost",
          },
          content: "ghost",
          lockVersion: 1,
        }),
      });

      expect(res.status).toBe(404);
    });

    it("returns 403 when trying to update package from another org", async () => {
      const otherCtx = await createTestContext({ orgSlug: "foreignorg" });
      await seedFlow({
        id: "@foreignorg/their-flow",
        orgId: otherCtx.orgId,
        createdBy: otherCtx.user.id,
      });

      const res = await app.request("/api/packages/flows/@foreignorg/their-flow", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: "@foreignorg/their-flow",
            version: "0.2.0",
            type: "flow",
            schemaVersion: "1.0",
            displayName: "Hijack Flow",
            description: "Hijack",
          },
          content: "hijack",
          lockVersion: 1,
        }),
      });

      expect(res.status).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════
  // DELETE /api/packages/flows/:scope/:name — delete flow (admin only)
  // ═══════════════════════════════════════════════

  describe("DELETE /api/packages/flows/:scope/:name", () => {
    it("deletes a flow", async () => {
      await seedFlow({
        id: "@pkgorg/delete-me",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/flows/@pkgorg/delete-me", {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(204);
      await assertDbMissing(packages, eq(packages.id, "@pkgorg/delete-me"));
    });

    it("returns 403 when trying to delete package from another org", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherdelorg" });
      await seedFlow({
        id: "@otherdelorg/their-flow",
        orgId: otherCtx.orgId,
        createdBy: otherCtx.user.id,
      });

      const res = await app.request("/api/packages/flows/@otherdelorg/their-flow", {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(403);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/packages/flows/@pkgorg/delete-me", { method: "DELETE" });

      expect(res.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════
  // GET /api/packages/flows/:scope/:name/versions — list versions
  // ═══════════════════════════════════════════════

  describe("GET /api/packages/flows/:scope/:name/versions", () => {
    it("returns empty versions list for a flow with no versions", async () => {
      await seedFlow({
        id: "@pkgorg/no-ver-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/flows/@pkgorg/no-ver-flow/versions", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.versions).toBeArray();
      expect(body.versions).toHaveLength(0);
    });

    it("returns seeded versions", async () => {
      await seedFlow({
        id: "@pkgorg/versioned-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      await seedPackageVersion({
        packageId: "@pkgorg/versioned-flow",
        version: "0.1.0",
      });
      await seedPackageVersion({
        packageId: "@pkgorg/versioned-flow",
        version: "0.2.0",
      });

      const res = await app.request("/api/packages/flows/@pkgorg/versioned-flow/versions", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.versions).toBeArray();
      expect(body.versions.length).toBeGreaterThanOrEqual(2);
    });

    it("returns 404 for non-existent package", async () => {
      const res = await app.request("/api/packages/flows/@pkgorg/no-such-flow/versions", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/packages/flows/@pkgorg/versioned-flow/versions");

      expect(res.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════
  // GET /api/packages/skills/:scope/:name/versions — list skill versions
  // ═══════════════════════════════════════════════

  describe("GET /api/packages/skills/:scope/:name/versions", () => {
    it("returns versions for a skill", async () => {
      await seedPackage({
        id: "@pkgorg/versioned-skill",
        orgId: ctx.orgId,
        type: "skill",
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@pkgorg/versioned-skill",
          version: "0.1.0",
          type: "skill",
          description: "Versioned skill",
        },
        draftContent: "# Skill",
      });

      await seedPackageVersion({
        packageId: "@pkgorg/versioned-skill",
        version: "1.0.0",
      });

      const res = await app.request("/api/packages/skills/@pkgorg/versioned-skill/versions", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.versions).toBeArray();
      expect(body.versions.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════
  // POST /api/packages/import — import from ZIP
  // ═══════════════════════════════════════════════

  describe("POST /api/packages/import", () => {
    it("returns 400 when no file is provided", async () => {
      const formData = new FormData();

      const res = await app.request("/api/packages/import", {
        method: "POST",
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
        body: formData,
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for non-zip file extension", async () => {
      const formData = new FormData();
      formData.append("file", new File([new Uint8Array([1, 2, 3])], "package.txt"));

      const res = await app.request("/api/packages/import", {
        method: "POST",
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
        body: formData,
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid zip content", async () => {
      const formData = new FormData();
      // Use non-zero bytes — Hono's test FormData parser drops filename on all-zero content (Bun bug)
      formData.append("file", new File([new Uint8Array([1, 2, 3, 4])], "bad-package.zip"));

      const res = await app.request("/api/packages/import", {
        method: "POST",
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
        body: formData,
      });

      expect(res.status).toBe(400);
    });

    it("returns 401 without authentication", async () => {
      const formData = new FormData();
      formData.append("file", new File([new Uint8Array([1])], "import.zip"));

      const res = await app.request("/api/packages/import", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════
  // Multi-tenancy and org isolation
  // ═══════════════════════════════════════════════

  describe("Multi-tenancy isolation", () => {
    it("isolates packages across organizations", async () => {
      const otherCtx = await createTestContext({ orgSlug: "isolatedorg" });

      await seedFlow({
        id: "@pkgorg/my-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      await seedFlow({
        id: "@isolatedorg/their-flow",
        orgId: otherCtx.orgId,
        createdBy: otherCtx.user.id,
      });

      // User from pkgorg should only see their own flows
      const res1 = await app.request("/api/packages/flows", {
        headers: authHeaders(ctx),
      });
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as any;
      const myFlow = body1.flows.find((f: { id: string }) => f.id === "@pkgorg/my-flow");
      const theirFlow = body1.flows.find((f: { id: string }) => f.id === "@isolatedorg/their-flow");
      expect(myFlow).toBeDefined();
      expect(theirFlow).toBeUndefined();

      // User from isolatedorg should only see their own flows
      const res2 = await app.request("/api/packages/flows", {
        headers: {
          Cookie: otherCtx.cookie,
          "X-Org-Id": otherCtx.orgId,
        },
      });
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as any;
      const theirFlow2 = body2.flows.find(
        (f: { id: string }) => f.id === "@isolatedorg/their-flow",
      );
      const myFlow2 = body2.flows.find((f: { id: string }) => f.id === "@pkgorg/my-flow");
      expect(theirFlow2).toBeDefined();
      expect(myFlow2).toBeUndefined();
    });

    it("prevents cross-org package detail access", async () => {
      const otherCtx = await createTestContext({ orgSlug: "crossorg" });
      await seedPackage({
        id: "@crossorg/secret-skill",
        orgId: otherCtx.orgId,
        type: "skill",
        createdBy: otherCtx.user.id,
        draftManifest: {
          name: "@crossorg/secret-skill",
          version: "0.1.0",
          type: "skill",
          description: "Secret",
        },
      });

      const res = await app.request("/api/packages/skills/@crossorg/secret-skill", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════
  // Version info endpoint
  // ═══════════════════════════════════════════════

  describe("GET /api/packages/flows/:scope/:name/versions/info", () => {
    it("returns version info for a flow", async () => {
      await seedFlow({
        id: "@pkgorg/info-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/flows/@pkgorg/info-flow/versions/info", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      // Version info response should contain structured data
      expect(body).toBeDefined();
    });

    it("returns 404 for non-existent flow", async () => {
      const res = await app.request("/api/packages/flows/@pkgorg/ghost/versions/info", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });
  });
});
