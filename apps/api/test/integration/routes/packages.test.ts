// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { assertDbMissing, assertDbHas } from "../../helpers/assertions.ts";
import { packages, packageDistTags } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { db } from "../../helpers/db.ts";

const app = getTestApp();

describe("Packages API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "pkgorg" });
  });

  // ═══════════════════════════════════════════════
  // GET /api/packages/agents — list agents
  // ═══════════════════════════════════════════════

  describe("GET /api/packages/agents", () => {
    it("returns empty list when no agents exist", async () => {
      const res = await app.request("/api/packages/agents", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.agents).toBeArray();
      expect(body.agents).toHaveLength(0);
    });

    it("returns agents owned by the org", async () => {
      await seedAgent({
        id: "@pkgorg/list-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/agents", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const agent = body.agents.find((f: { id: string }) => f.id === "@pkgorg/list-agent");
      expect(agent).toBeDefined();
    });

    it("does not leak agents from other orgs", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      await seedAgent({
        id: "@otherorg/secret-agent",
        orgId: otherCtx.orgId,
        createdBy: otherCtx.user.id,
      });

      const res = await app.request("/api/packages/agents", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const leaked = body.agents.find((f: { id: string }) => f.id === "@otherorg/secret-agent");
      expect(leaked).toBeUndefined();
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/packages/agents");
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
  // GET /api/packages/agents/:scope/:name — agent detail
  // ═══════════════════════════════════════════════

  describe("GET /api/packages/agents/:scope/:name", () => {
    it("returns agent detail with versionCount and hasUnarchivedChanges", async () => {
      await seedAgent({
        id: "@pkgorg/detail-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/agents/@pkgorg/detail-agent", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.agent).toBeDefined();
      expect(body.agent.id).toBe("@pkgorg/detail-agent");
      expect(body.agent.versionCount).toBe(0);
      expect(body.agent.hasUnarchivedChanges).toBe(true);
    });

    it("returns hasUnarchivedChanges false when no changes since last version", async () => {
      await seedAgent({
        id: "@pkgorg/versioned-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      // Create a version with a createdAt in the future to ensure updatedAt < createdAt
      await seedPackageVersion({
        packageId: "@pkgorg/versioned-agent",
        version: "0.1.0",
        createdAt: new Date(Date.now() + 60_000),
      });

      const res = await app.request("/api/packages/agents/@pkgorg/versioned-agent", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.agent.versionCount).toBe(1);
      expect(body.agent.hasUnarchivedChanges).toBe(false);
    });

    it("returns 404 for non-existent package", async () => {
      const res = await app.request("/api/packages/agents/@pkgorg/does-not-exist", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 404 for package from another org", async () => {
      const otherCtx = await createTestContext({ orgSlug: "alien" });
      await seedAgent({
        id: "@alien/private-agent",
        orgId: otherCtx.orgId,
        createdBy: otherCtx.user.id,
      });

      const res = await app.request("/api/packages/agents/@alien/private-agent", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/packages/agents/@pkgorg/detail-agent");
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
  // POST /api/packages/agents — create agent (admin only)
  // ═══════════════════════════════════════════════

  describe("POST /api/packages/agents", () => {
    it("creates an agent with valid manifest and content", async () => {
      const res = await app.request("/api/packages/agents", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: `@pkgorg/new-agent`,
            version: "0.1.0",
            type: "agent",
            schemaVersion: "1.0",
            displayName: "New Agent",
            description: "A brand new agent",
          },
          content: "You are a helpful assistant.",
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.packageId).toBe("@pkgorg/new-agent");
      expect(body.lockVersion).toBeNumber();

      await assertDbHas(packages, eq(packages.id, "@pkgorg/new-agent"));
    });

    it("returns 400 when content is empty", async () => {
      const res = await app.request("/api/packages/agents", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: `@pkgorg/empty-content`,
            version: "0.1.0",
            type: "agent",
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
      await seedAgent({
        id: "@pkgorg/dup-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/agents", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: "@pkgorg/dup-agent",
            version: "0.1.0",
            type: "agent",
            schemaVersion: "1.0",
            displayName: "Dup Agent",
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
      const res = await app.request("/api/packages/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          manifest: {
            name: "@pkgorg/unauth-agent",
            version: "0.1.0",
            type: "agent",
            schemaVersion: "1.0",
            displayName: "Unauth Agent",
            description: "No auth",
          },
          content: "no auth prompt",
        }),
      });

      expect(res.status).toBe(401);
    });

    it("returns 403 when scope does not match org", async () => {
      const res = await app.request("/api/packages/agents", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: "@wrongorg/mismatched-agent",
            version: "0.1.0",
            type: "agent",
            schemaVersion: "1.0",
            displayName: "Mismatched Agent",
            description: "Wrong scope",
          },
          content: "wrong scope prompt",
        }),
      });

      expect(res.status).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════
  // PUT /api/packages/agents/:scope/:name — update agent (admin only)
  // ═══════════════════════════════════════════════

  describe("PUT /api/packages/agents/:scope/:name", () => {
    it("updates an agent with valid manifest and lockVersion", async () => {
      const agent = await seedAgent({
        id: "@pkgorg/update-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/agents/@pkgorg/update-agent", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: "@pkgorg/update-agent",
            version: "0.2.0",
            type: "agent",
            schemaVersion: "1.0",
            displayName: "Update Agent",
            description: "Updated agent",
          },
          content: "Updated prompt content.",
          lockVersion: agent.lockVersion,
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.packageId).toBe("@pkgorg/update-agent");
      expect(body.lockVersion).toBeGreaterThan(agent.lockVersion!);
    });

    it("returns 400 when lockVersion is missing", async () => {
      await seedAgent({
        id: "@pkgorg/no-lock-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/agents/@pkgorg/no-lock-agent", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: "@pkgorg/no-lock-agent",
            version: "0.2.0",
            type: "agent",
            schemaVersion: "1.0",
            displayName: "No Lock Agent",
            description: "No lockVersion",
          },
          content: "content",
        }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent agent", async () => {
      const res = await app.request("/api/packages/agents/@pkgorg/ghost-agent", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: "@pkgorg/ghost-agent",
            version: "0.1.0",
            type: "agent",
            schemaVersion: "1.0",
            displayName: "Ghost Agent",
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
      await seedAgent({
        id: "@foreignorg/their-agent",
        orgId: otherCtx.orgId,
        createdBy: otherCtx.user.id,
      });

      const res = await app.request("/api/packages/agents/@foreignorg/their-agent", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: "@foreignorg/their-agent",
            version: "0.2.0",
            type: "agent",
            schemaVersion: "1.0",
            displayName: "Hijack Agent",
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
  // DELETE /api/packages/agents/:scope/:name — delete agent (admin only)
  // ═══════════════════════════════════════════════

  describe("DELETE /api/packages/agents/:scope/:name", () => {
    it("deletes an agent", async () => {
      await seedAgent({
        id: "@pkgorg/delete-me",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/agents/@pkgorg/delete-me", {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(204);
      await assertDbMissing(packages, eq(packages.id, "@pkgorg/delete-me"));
    });

    it("returns 403 when trying to delete package from another org", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherdelorg" });
      await seedAgent({
        id: "@otherdelorg/their-agent",
        orgId: otherCtx.orgId,
        createdBy: otherCtx.user.id,
      });

      const res = await app.request("/api/packages/agents/@otherdelorg/their-agent", {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(403);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/packages/agents/@pkgorg/delete-me", { method: "DELETE" });

      expect(res.status).toBe(401);
    });

    it("allows deleting an imported package with foreign scope", async () => {
      await seedAgent({
        id: "@foreignscope/imported-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/agents/@foreignscope/imported-agent", {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(204);
      await assertDbMissing(packages, eq(packages.id, "@foreignscope/imported-agent"));
    });

    it("returns 403 when trying to delete a package owned by another org (DB check)", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherdelorg2" });
      await seedAgent({
        id: "@foreignscope/other-org-agent",
        orgId: otherCtx.orgId,
        createdBy: otherCtx.user.id,
      });

      const res = await app.request("/api/packages/agents/@foreignscope/other-org-agent", {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════
  // GET /api/packages/agents/:scope/:name/versions — list versions
  // ═══════════════════════════════════════════════

  describe("GET /api/packages/agents/:scope/:name/versions", () => {
    it("returns empty versions list for an agent with no versions", async () => {
      await seedAgent({
        id: "@pkgorg/no-ver-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/agents/@pkgorg/no-ver-agent/versions", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.versions).toBeArray();
      expect(body.versions).toHaveLength(0);
    });

    it("returns seeded versions", async () => {
      await seedAgent({
        id: "@pkgorg/versioned-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      await seedPackageVersion({
        packageId: "@pkgorg/versioned-agent",
        version: "0.1.0",
      });
      await seedPackageVersion({
        packageId: "@pkgorg/versioned-agent",
        version: "0.2.0",
      });

      const res = await app.request("/api/packages/agents/@pkgorg/versioned-agent/versions", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.versions).toBeArray();
      expect(body.versions.length).toBeGreaterThanOrEqual(2);
    });

    it("returns 404 for non-existent package", async () => {
      const res = await app.request("/api/packages/agents/@pkgorg/no-such-agent/versions", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/packages/agents/@pkgorg/versioned-agent/versions");

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
        headers: authHeaders(ctx),
        body: formData,
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for non-zip file extension", async () => {
      const formData = new FormData();
      formData.append("file", new File([new Uint8Array([1, 2, 3])], "package.txt"));

      const res = await app.request("/api/packages/import", {
        method: "POST",
        headers: authHeaders(ctx),
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
        headers: authHeaders(ctx),
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

      await seedAgent({
        id: "@pkgorg/my-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      await seedAgent({
        id: "@isolatedorg/their-agent",
        orgId: otherCtx.orgId,
        createdBy: otherCtx.user.id,
      });

      // User from pkgorg should only see their own agents
      const res1 = await app.request("/api/packages/agents", {
        headers: authHeaders(ctx),
      });
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as any;
      const myAgent = body1.agents.find((f: { id: string }) => f.id === "@pkgorg/my-agent");
      const theirAgent = body1.agents.find(
        (f: { id: string }) => f.id === "@isolatedorg/their-agent",
      );
      expect(myAgent).toBeDefined();
      expect(theirAgent).toBeUndefined();

      // User from isolatedorg should only see their own agents
      const res2 = await app.request("/api/packages/agents", {
        headers: authHeaders(otherCtx),
      });
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as any;
      const theirAgent2 = body2.agents.find(
        (f: { id: string }) => f.id === "@isolatedorg/their-agent",
      );
      const myAgent2 = body2.agents.find((f: { id: string }) => f.id === "@pkgorg/my-agent");
      expect(theirAgent2).toBeDefined();
      expect(myAgent2).toBeUndefined();
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

  describe("GET /api/packages/agents/:scope/:name/versions/info", () => {
    it("returns activeVersion from manifest when no published versions exist", async () => {
      await seedAgent({
        id: "@pkgorg/info-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@pkgorg/info-agent",
          version: "1.2.0",
          type: "agent",
          description: "Test",
        },
      });

      const res = await app.request("/api/packages/agents/@pkgorg/info-agent/versions/info", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.activeVersion).toBe("1.2.0");
      expect(body.latestPublishedVersion).toBeNull();
    });

    it("returns latestPublishedVersion when a version with dist-tag exists", async () => {
      await seedAgent({
        id: "@pkgorg/published-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@pkgorg/published-agent",
          version: "2.0.0",
          type: "agent",
          description: "Test",
        },
      });

      const pv = await seedPackageVersion({
        packageId: "@pkgorg/published-agent",
        version: "1.0.0",
        manifest: {
          name: "@pkgorg/published-agent",
          version: "1.0.0",
          type: "agent",
        },
      });

      // Create the "latest" dist-tag pointing to this version
      await db.insert(packageDistTags).values({
        packageId: "@pkgorg/published-agent",
        tag: "latest",
        versionId: pv.id,
      });

      const res = await app.request("/api/packages/agents/@pkgorg/published-agent/versions/info", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.activeVersion).toBe("2.0.0");
      expect(body.latestPublishedVersion).toBe("1.0.0");
    });

    it("returns 404 for non-existent agent", async () => {
      const res = await app.request("/api/packages/agents/@pkgorg/ghost/versions/info", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });
  });
});
