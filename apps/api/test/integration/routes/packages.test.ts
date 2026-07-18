// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { zipSync } from "fflate";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import {
  seedAgent,
  seedPackage,
  seedPackageVersion,
  seedApplication,
  seedInstalledPackage,
} from "../../helpers/seed.ts";
import {
  initSystemIntegrations,
  __resetSystemIntegrationsForTest,
} from "../../../src/services/integration-client-registry.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { assertDbMissing, assertDbHas } from "../../helpers/assertions.ts";
import { auditEvents, packages, packageDistTags } from "@appstrate/db/schema";
import { and, eq } from "drizzle-orm";
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
      expect(body.data).toBeArray();
      expect(body.data).toHaveLength(0);
    });

    it("returns agents owned by the org", async () => {
      await seedAgent({
        id: "@pkgorg/list-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@pkgorg/list-agent",
      );

      const res = await app.request("/api/packages/agents", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const agent = body.data.find((f: { id: string }) => f.id === "@pkgorg/list-agent");
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
      const leaked = body.data.find((f: { id: string }) => f.id === "@otherorg/secret-agent");
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
      expect(body.object).toBe("list");
      expect(body.data).toBeArray();
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
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@pkgorg/my-skill",
      );

      const res = await app.request("/api/packages/skills", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const skill = body.data.find((s: { id: string }) => s.id === "@pkgorg/my-skill");
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
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@pkgorg/detail-agent",
      );

      const res = await app.request("/api/packages/agents/@pkgorg/detail-agent", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body).toBeDefined();
      expect(body.id).toBe("@pkgorg/detail-agent");
      expect(body.version_count).toBe(0);
      expect(body.has_unarchived_changes).toBe(true);
    });

    it("accepts an encoded @ scope", async () => {
      await seedAgent({
        id: "@pkgorg/encoded-detail-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@pkgorg/encoded-detail-agent",
      );

      const res = await app.request("/api/packages/agents/%40pkgorg/encoded-detail-agent", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { id?: string };
      expect(body.id).toBe("@pkgorg/encoded-detail-agent");
    });

    it("returns hasUnarchivedChanges false when no changes since last version", async () => {
      await seedAgent({
        id: "@pkgorg/versioned-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@pkgorg/versioned-agent",
      );

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
      expect(body.version_count).toBe(1);
      expect(body.has_unarchived_changes).toBe(false);
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
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@pkgorg/detail-skill",
      );

      const res = await app.request("/api/packages/skills/@pkgorg/detail-skill", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body).toBeDefined();
      expect(body.id).toBe("@pkgorg/detail-skill");
    });

    it("returns 404 for non-existent skill", async () => {
      const res = await app.request("/api/packages/skills/@pkgorg/nope", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 404 from custom app when skill is not installed", async () => {
      await seedPackage({
        id: "@pkgorg/hidden-skill",
        orgId: ctx.orgId,
        type: "skill",
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@pkgorg/hidden-skill",
          version: "0.1.0",
          type: "skill",
          description: "Hidden from custom app",
        },
        draftContent: "# Hidden",
      });

      const customApp = await seedApplication({
        orgId: ctx.orgId,
        name: "Skill Custom",
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/skills/@pkgorg/hidden-skill", {
        headers: { ...authHeaders(ctx), "X-Application-Id": customApp.id },
      });

      expect(res.status).toBe(404);
    });

    it("returns 200 from custom app when skill is installed", async () => {
      await seedPackage({
        id: "@pkgorg/installed-skill",
        orgId: ctx.orgId,
        type: "skill",
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@pkgorg/installed-skill",
          version: "0.1.0",
          type: "skill",
          description: "Installed in custom app",
        },
        draftContent: "# Installed",
      });

      const customApp = await seedApplication({
        orgId: ctx.orgId,
        name: "Skill Installed",
        createdBy: ctx.user.id,
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: customApp.id },
        "@pkgorg/installed-skill",
      );

      const res = await app.request("/api/packages/skills/@pkgorg/installed-skill", {
        headers: { ...authHeaders(ctx), "X-Application-Id": customApp.id },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe("@pkgorg/installed-skill");
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
            schema_version: "0.1",
            display_name: "New Agent",
            description: "A brand new agent",
          },
          content: "You are a helpful assistant.",
        }),
      });

      expect(res.status).toBe(201);
      // Bare created resource (issue #657): `id` + `lock_version` are resource
      // state; no `packageId`/`message` envelope.
      const body = (await res.json()) as any;
      expect(body.id).toBe("@pkgorg/new-agent");
      expect(body.lock_version).toBeNumber();
      expect(body.packageId).toBeUndefined();
      expect(body.message).toBeUndefined();

      await assertDbHas(packages, eq(packages.id, "@pkgorg/new-agent"));

      // The creation leaves an audit trail (package.created, actor = caller).
      const auditRows = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "package.created"),
            eq(auditEvents.resourceId, "@pkgorg/new-agent"),
          ),
        );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]!.orgId).toBe(ctx.orgId);
      expect(auditRows[0]!.resourceType).toBe("package");
      expect(auditRows[0]!.actorType).toBe("user");
      expect(auditRows[0]!.actorId).toBe(ctx.user.id);
      expect(auditRows[0]!.after).toMatchObject({ type: "agent", version: "0.1.0" });
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
            schema_version: "0.1",
            display_name: "Empty Content",
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
            schema_version: "0.1",
            display_name: "Dup Agent",
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
            schema_version: "0.1",
            display_name: "Unauth Agent",
            description: "No auth",
          },
          content: "no auth prompt",
        }),
      });

      expect(res.status).toBe(401);
    });

    it("creates an agent under a foreign scope (scope no longer gates creation)", async () => {
      const res = await app.request("/api/packages/agents", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: "@otherscope/foreign-agent",
            version: "0.1.0",
            type: "agent",
            schema_version: "0.1",
            display_name: "Foreign Scope Agent",
            description: "Different scope, same org",
          },
          content: "foreign scope prompt",
        }),
      });

      // The package is created under the caller's org regardless of its scope name.
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      expect(body.id).toBe("@otherscope/foreign-agent");
    });
  });

  // ═══════════════════════════════════════════════
  // GET /api/packages/integrations?active=true — agent-editor picker
  // ═══════════════════════════════════════════════

  describe("GET /api/packages/integrations?active=true (agent-editor picker)", () => {
    const ENV_SYSTEM = "@pkgorg/gmail"; // env SYSTEM integration, no install row
    const PLAIN = "@pkgorg/clickup"; // org integration, not installed
    const INSTALLED = "@pkgorg/notion"; // org integration, installed + enabled

    beforeEach(async () => {
      // A deployment offering a shared OAuth client for gmail via
      // SYSTEM_INTEGRATIONS — auto-active without an install row.
      initSystemIntegrations([
        {
          id: ENV_SYSTEM,
          clients: [
            {
              id: "gmail-system",
              auth_key: "google",
              client_id: "sys.apps.googleusercontent.com",
              client_secret: "sys-secret",
            },
          ],
        },
      ]);
      // gmail ships as a system-source package (visible in the catalogue with
      // no install row, like the real one).
      await seedPackage({ id: ENV_SYSTEM, orgId: null, type: "integration", source: "system" });
      await seedPackage({ id: PLAIN, orgId: ctx.orgId, type: "integration" });
      await seedPackage({ id: INSTALLED, orgId: ctx.orgId, type: "integration" });
      await seedInstalledPackage(ctx.defaultAppId, INSTALLED, { enabled: true });
    });

    afterEach(() => {
      __resetSystemIntegrationsForTest();
    });

    async function activeIds(): Promise<Set<string>> {
      const res = await app.request("/api/packages/integrations?active=true", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string }[] };
      return new Set(body.data.map((i) => i.id));
    }

    it("includes an env-backed SYSTEM integration with no install row (regression)", async () => {
      const ids = await activeIds();
      expect(ids.has(ENV_SYSTEM)).toBe(true);
    });

    it("includes an installed + enabled org integration", async () => {
      const ids = await activeIds();
      expect(ids.has(INSTALLED)).toBe(true);
    });

    it("excludes a non-system org integration with no install row", async () => {
      const ids = await activeIds();
      expect(ids.has(PLAIN)).toBe(false);
    });

    it("excludes a SYSTEM integration with a sticky explicit disable", async () => {
      await seedInstalledPackage(ctx.defaultAppId, ENV_SYSTEM, { enabled: false });
      const ids = await activeIds();
      expect(ids.has(ENV_SYSTEM)).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════
  // POST/PUT /api/packages/integrations — JSON-body manifest editor
  // ═══════════════════════════════════════════════

  describe("POST /api/packages/integrations", () => {
    const remoteIntegrationManifest = (name: string) => ({
      name,
      version: "1.0.0",
      type: "integration",
      schema_version: "0.1",
      display_name: "Remote Integration",
      description: "A remote HTTP MCP integration",
      source: {
        kind: "remote",
        remote: { url: "https://example.com/mcp/v1", transport: "streamable-http" },
      },
      auths: {
        primary: {
          type: "api_key",
          authorized_uris: ["https://example.com/**"],
          credentials: {
            schema: {
              type: "object",
              required: ["api_key"],
              properties: { api_key: { type: "string" } },
            },
          },
          delivery: {
            http: {
              in: "header",
              name: "Authorization",
              prefix: "Bearer ",
              value: "{$credential.api_key}",
            },
          },
        },
      },
    });

    it("creates an integration from a JSON manifest", async () => {
      const res = await app.request("/api/packages/integrations", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: remoteIntegrationManifest("@pkgorg/new-integration"),
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.id).toBe("@pkgorg/new-integration");
      expect(body.lock_version).toBeNumber();
      expect(body.packageId).toBeUndefined();

      await assertDbHas(packages, eq(packages.id, "@pkgorg/new-integration"));
    });

    it("returns 400 for an invalid integration manifest", async () => {
      const res = await app.request("/api/packages/integrations", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: "@pkgorg/bad-integration",
            version: "1.0.0",
            type: "integration",
            schema_version: "0.1",
            display_name: "Bad",
            description: "No auths declared",
            source: {
              kind: "remote",
              remote: { url: "https://example.com/mcp/v1", transport: "streamable-http" },
            },
          },
        }),
      });

      expect(res.status).toBe(400);
    });

    it("updates an integration manifest with lock_version", async () => {
      const createRes = await app.request("/api/packages/integrations", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ manifest: remoteIntegrationManifest("@pkgorg/edit-integration") }),
      });
      const created = (await createRes.json()) as any;

      const res = await app.request("/api/packages/integrations/@pkgorg/edit-integration", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            ...remoteIntegrationManifest("@pkgorg/edit-integration"),
            display_name: "Renamed Integration",
          },
          lock_version: created.lock_version,
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.lock_version).toBeGreaterThan(created.lock_version);
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
            schema_version: "0.1",
            display_name: "Update Agent",
            description: "Updated agent",
          },
          content: "Updated prompt content.",
          lock_version: agent.lockVersion,
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe("@pkgorg/update-agent");
      expect(body.lock_version).toBeGreaterThan(agent.lockVersion!);
      expect(body.packageId).toBeUndefined();
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
            schema_version: "0.1",
            display_name: "No Lock Agent",
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
            schema_version: "0.1",
            display_name: "Ghost Agent",
            description: "Ghost",
          },
          content: "ghost",
          lock_version: 1,
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
            schema_version: "0.1",
            display_name: "Hijack Agent",
            description: "Hijack",
          },
          content: "hijack",
          lock_version: 1,
        }),
      });

      expect(res.status).toBe(403);
    });

    it("updates a package the org owns even when its scope differs from the org slug", async () => {
      // Seeded under ctx's org (pkgorg) but with a foreign scope — e.g. an imported package.
      const agent = await seedAgent({
        id: "@otherscope/imported-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/agents/@otherscope/imported-agent", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: "@otherscope/imported-agent",
            version: "0.2.0",
            type: "agent",
            schema_version: "0.1",
            display_name: "Edited Imported Agent",
            description: "Edited despite foreign scope",
          },
          content: "edited prompt",
          lock_version: agent.lockVersion,
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { lock_version: number };
      expect(body.lock_version).toBeGreaterThan(agent.lockVersion!);
    });

    it("deletes a package the org owns even when its scope differs from the org slug", async () => {
      await seedAgent({
        id: "@otherscope/deletable-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/agents/@otherscope/deletable-agent", {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect([200, 204]).toContain(res.status);
    });
  });

  // ═══════════════════════════════════════════════
  // Niveau 2 Phase 1 — install-time integration scope validation
  // (assertAgentIntegrationScopesValid in routes/packages.ts)
  // ═══════════════════════════════════════════════

  describe("agent install — integration scope validation", () => {
    const integrationId = "@pkgorg/gmail-mcp-test";

    async function seedGmailIntegration() {
      await seedPackage({
        id: integrationId,
        orgId: ctx.orgId,
        type: "integration",
        source: "local",
        draftManifest: {
          type: "integration",
          schema_version: "0.1",
          name: integrationId,
          version: "1.0.0",
          display_name: "Gmail (test)",
          source: { kind: "local", server: { name: "@pkgorg/gmail-server", version: "^1.0.0" } },
          auths: {
            primary: {
              type: "oauth2",
              authorization_endpoint: "https://idp/a",
              token_endpoint: "https://idp/t",
              authorized_uris: ["https://api/*"],
              delivery: {
                http: {
                  in: "header",
                  name: "Authorization",
                  prefix: "Bearer ",
                  value: "{$credential.access_token}",
                },
              },
              scope_catalog: [
                { value: "read", label: "Read" },
                { value: "send", label: "Send" },
              ],
            },
          },
          tools_policy: {
            list_messages: { required_scopes: { primary: ["read"] } },
            send_message: { required_scopes: { primary: ["send"] } },
          },
        },
      });
    }

    function buildAgentBody(
      selection: { version: string; tools?: string[]; scopes?: string[] } | string,
      suffix = "ok",
    ) {
      // AFPS §4.1/§4.4 — the dependency value is a bare semver string;
      // tool/scope selection lives in the top-level `integrations_configuration`
      // block (both read by `parseManifestIntegrations`).
      const version = typeof selection === "string" ? selection : selection.version;
      const config =
        typeof selection === "string"
          ? undefined
          : selection.tools !== undefined || selection.scopes !== undefined
            ? {
                ...(selection.tools !== undefined ? { tools: selection.tools } : {}),
                ...(selection.scopes !== undefined ? { scopes: selection.scopes } : {}),
              }
            : undefined;
      const manifest: Record<string, unknown> = {
        name: `@pkgorg/agent-${suffix}`,
        version: "0.1.0",
        type: "agent",
        schema_version: "0.2",
        display_name: `Agent ${suffix}`,
        dependencies: {
          integrations: { [integrationId]: version },
        },
        ...(config ? { integrations_configuration: { [integrationId]: config } } : {}),
      };
      return { manifest, content: "Prompt" };
    }

    it("accepts an agent whose tool selection is a subset of the integration's catalog", async () => {
      await seedGmailIntegration();
      const res = await app.request("/api/packages/agents", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify(
          buildAgentBody({ version: "^1.0.0", tools: ["list_messages"], scopes: ["read"] }, "ok"),
        ),
      });
      expect(res.status).toBe(201);
    });

    it("rejects an agent selecting a tool not declared by the integration", async () => {
      await seedGmailIntegration();
      const res = await app.request("/api/packages/agents", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify(
          buildAgentBody({ version: "^1.0.0", tools: ["delete_message"] }, "bad-tool"),
        ),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors?: { code: string; field: string }[] };
      expect(body.errors?.[0]?.code).toBe("unknown_tool");
      expect(body.errors?.[0]?.field).toBe(`integrations_configuration.${integrationId}.tools`);
    });

    it("rejects an agent declaring a scope outside the integration's availableScopes", async () => {
      await seedGmailIntegration();
      const res = await app.request("/api/packages/agents", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify(
          buildAgentBody({ version: "^1.0.0", scopes: ["read", "admin"] }, "bad-scope"),
        ),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors?: { code: string }[] };
      expect(body.errors?.some((e) => e.code === "scope_not_in_catalog")).toBe(true);
    });

    it("accepts a bare-version-string integration dep with no selection block", async () => {
      await seedGmailIntegration();
      const res = await app.request("/api/packages/agents", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify(buildAgentBody("^1.0.0", "noselection")),
      });
      expect(res.status).toBe(201);
    });

    it("skips validation silently when the referenced integration is not installed in the org", async () => {
      // No seedGmailIntegration — the integration doesn't exist in this org.
      const res = await app.request("/api/packages/agents", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify(
          buildAgentBody({ version: "^1.0.0", tools: ["whatever"], scopes: ["foo"] }, "absent"),
        ),
      });
      // Phase 1 defers "integration must exist" to run-time dep validation.
      expect(res.status).toBe(201);
    });

    it("PUT also runs the scope validation", async () => {
      await seedGmailIntegration();
      const agent = await seedAgent({
        id: "@pkgorg/agent-put",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      const res = await app.request("/api/packages/agents/@pkgorg/agent-put", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: "@pkgorg/agent-put",
            version: "0.2.0",
            type: "agent",
            schema_version: "0.2",
            display_name: "Updated",
            dependencies: {
              integrations: { [integrationId]: "^1.0.0" },
            },
            integrations_configuration: { [integrationId]: { tools: ["nope"] } },
          },
          content: "Updated prompt",
          lock_version: agent.lockVersion,
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors?: { code: string }[] };
      expect(body.errors?.[0]?.code).toBe("unknown_tool");
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

      // The deletion leaves an audit trail (package.deleted, actor = caller).
      const auditRows = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "package.deleted"),
            eq(auditEvents.resourceId, "@pkgorg/delete-me"),
          ),
        );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]!.orgId).toBe(ctx.orgId);
      expect(auditRows[0]!.resourceType).toBe("package");
      expect(auditRows[0]!.actorId).toBe(ctx.user.id);
      expect(auditRows[0]!.after).toMatchObject({ type: "agent" });
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
  // POST /api/packages/agents/:scope/:name/versions — publish (re-validation gate)
  // ═══════════════════════════════════════════════

  describe("POST /api/packages/agents/:scope/:name/versions", () => {
    it("rejects publishing a draft with an orphan integrations_configuration entry", async () => {
      // integrations_configuration key with NO matching dependencies.integrations
      // entry — must be refused at the publish gate (AFPS §4.4 orphan-key rule).
      await seedPackage({
        id: "@pkgorg/orphan-config",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@pkgorg/orphan-config",
          version: "1.0.0",
          type: "agent",
          schema_version: "0.2",
          display_name: "Orphan Config",
          description: "Agent with orphan integration config",
          integrations_configuration: { "@acme/fathom": { tools: ["api_call"] } },
        },
        draftContent: "Prompt.",
      });

      const res = await app.request("/api/packages/agents/@pkgorg/orphan-config/versions", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it("publishes a valid draft", async () => {
      await seedPackage({
        id: "@pkgorg/valid-draft",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@pkgorg/valid-draft",
          version: "1.0.0",
          type: "agent",
          schema_version: "0.2",
          display_name: "Valid Draft",
          description: "Valid agent",
        },
        draftContent: "Prompt.",
      });

      const res = await app.request("/api/packages/agents/@pkgorg/valid-draft/versions", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBeLessThan(300);
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
    it("imports a valid .afps and records an audit event", async () => {
      const enc = (s: string) => new TextEncoder().encode(s);
      const afps = zipSync({
        "manifest.json": enc(
          JSON.stringify({
            name: "@pkgorg/imported-agent",
            version: "1.0.0",
            type: "agent",
            schema_version: "0.1",
            display_name: "Imported Agent",
            description: "Imported via ZIP",
          }),
        ),
        "prompt.md": enc("You are an imported agent."),
      });
      const formData = new FormData();
      formData.append("file", new File([new Uint8Array(afps)], "agent.afps"));

      const res = await app.request("/api/packages/import", {
        method: "POST",
        headers: authHeaders(ctx),
        body: formData,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.packageId).toBe("@pkgorg/imported-agent");

      const auditRows = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "package.created"),
            eq(auditEvents.resourceId, "@pkgorg/imported-agent"),
          ),
        );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]!.orgId).toBe(ctx.orgId);
      expect(auditRows[0]!.actorType).toBe("user");
      expect(auditRows[0]!.after).toMatchObject({
        type: "agent",
        version: "1.0.0",
        via: "import:zip",
        force: false,
      });
    });

    // The dashboard's resource-section ".afps import" (useUploadPackage) routes
    // skill/integration/agent ZIPs here — the per-type create endpoints are
    // JSON-only. Cover a non-agent type so type-detection on this path is
    // guarded.
    it("imports a skill .afps via type detection", async () => {
      const enc = (s: string) => new TextEncoder().encode(s);
      const afps = zipSync({
        "manifest.json": enc(
          JSON.stringify({
            name: "@pkgorg/imported-skill",
            version: "1.0.0",
            type: "skill",
            schema_version: "0.1",
            display_name: "Imported Skill",
            description: "Imported via ZIP",
          }),
        ),
        "SKILL.md": enc("---\nname: @pkgorg/imported-skill\n---\n\nSkill body."),
      });
      const formData = new FormData();
      formData.append("file", new File([new Uint8Array(afps)], "skill.afps"));

      const res = await app.request("/api/packages/import", {
        method: "POST",
        headers: authHeaders(ctx),
        body: formData,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.packageId).toBe("@pkgorg/imported-skill");
      expect(body.type).toBe("skill");
    });

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
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@pkgorg/my-agent",
      );
      await seedAgent({
        id: "@isolatedorg/their-agent",
        orgId: otherCtx.orgId,
        createdBy: otherCtx.user.id,
      });
      await installPackage(
        { orgId: otherCtx.orgId, applicationId: otherCtx.defaultAppId },
        "@isolatedorg/their-agent",
      );

      // User from pkgorg should only see their own agents
      const res1 = await app.request("/api/packages/agents", {
        headers: authHeaders(ctx),
      });
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as any;
      const myAgent = body1.data.find((f: { id: string }) => f.id === "@pkgorg/my-agent");
      const theirAgent = body1.data.find(
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
      const theirAgent2 = body2.data.find(
        (f: { id: string }) => f.id === "@isolatedorg/their-agent",
      );
      const myAgent2 = body2.data.find((f: { id: string }) => f.id === "@pkgorg/my-agent");
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
      expect(body.active_version).toBe("1.2.0");
      expect(body.latest_published_version).toBeNull();
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
      expect(body.active_version).toBe("2.0.0");
      expect(body.latest_published_version).toBe("1.0.0");
    });

    it("returns 404 for non-existent agent", async () => {
      const res = await app.request("/api/packages/agents/@pkgorg/ghost/versions/info", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════
  // Issue #657 — mutating endpoints return the affected resource BARE (same
  // shape as the GET detail). No operation envelope: `lock_version` and
  // `forked_from` are resource state inside the detail DTO.
  // ═══════════════════════════════════════════════

  describe("issue #657 — mutating package endpoints return the bare resource", () => {
    const agentManifest = (name: string, version = "0.1.0") => ({
      name,
      version,
      type: "agent",
      schema_version: "0.1",
      display_name: "Resource Agent",
      description: "Returns the full resource on mutation",
    });

    it("POST create agent returns the bare Agent detail DTO", async () => {
      const res = await app.request("/api/packages/agents", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: agentManifest("@pkgorg/res-agent"),
          content: "You are a helpful assistant.",
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      // Full Agent detail resource (same serializer as GET detail).
      expect(body.id).toBe("@pkgorg/res-agent");
      expect(body.display_name).toBe("Resource Agent");
      expect(body.dependencies).toBeDefined();
      expect(body.config).toBeDefined();
      expect(body.version_count).toBeNumber();
      // `lock_version` is resource state (draft optimistic-lock token).
      expect(body.lock_version).toBeNumber();
      // No operation envelope.
      expect(body.packageId).toBeUndefined();
      expect(body.message).toBeUndefined();
      expect(body.warnings).toBeUndefined();
    });

    it("POST create integration returns the bare package detail DTO", async () => {
      const res = await app.request("/api/packages/integrations", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: "@pkgorg/res-integration",
            version: "0.1.0",
            type: "integration",
            schema_version: "0.1",
            display_name: "Resource Integration",
            description: "A remote HTTP MCP integration",
            source: {
              kind: "remote",
              remote: { url: "https://example.com/mcp/v1", transport: "streamable-http" },
            },
            auths: {
              primary: {
                type: "api_key",
                authorized_uris: ["https://example.com/**"],
                credentials: {
                  schema: {
                    type: "object",
                    required: ["api_key"],
                    properties: { api_key: { type: "string" } },
                  },
                },
                delivery: {
                  http: {
                    in: "header",
                    name: "Authorization",
                    prefix: "Bearer ",
                    value: "{$credential.api_key}",
                  },
                },
              },
            },
          },
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      // Full OrgPackageItemDetail resource, bare.
      expect(body.id).toBe("@pkgorg/res-integration");
      expect(body.lock_version).toBeNumber();
      expect(body.manifest).toBeDefined();
      expect(body.version_count).toBeNumber();
      expect(body.has_unarchived_changes).toBeBoolean();
      // No operation envelope.
      expect(body.packageId).toBeUndefined();
      expect(body.message).toBeUndefined();
    });

    it("PUT update agent returns the bare Agent detail DTO with the new lock_version", async () => {
      const create = await app.request("/api/packages/agents", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: agentManifest("@pkgorg/upd-res-agent"),
          content: "original prompt",
        }),
      });
      const created = (await create.json()) as any;

      const res = await app.request("/api/packages/agents/@pkgorg/upd-res-agent", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: agentManifest("@pkgorg/upd-res-agent"),
          content: "updated prompt",
          lock_version: created.lock_version,
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      // Full Agent detail resource, bare. The resource carries the NEW
      // `lock_version` consumers read back before the next edit.
      expect(body.id).toBe("@pkgorg/upd-res-agent");
      expect(body.lock_version).toBeGreaterThan(created.lock_version);
      expect(body.dependencies).toBeDefined();
      expect(body.config).toBeDefined();
      // No operation envelope.
      expect(body.packageId).toBeUndefined();
      expect(body.warnings).toBeUndefined();
    });

    it("POST create version returns the bare version detail DTO", async () => {
      const create = await app.request("/api/packages/agents", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: agentManifest("@pkgorg/ver-res-agent"),
          content: "v1 prompt",
        }),
      });
      const created = (await create.json()) as any;

      // Change the draft so a new version is not a no-op.
      await app.request("/api/packages/agents/@pkgorg/ver-res-agent", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: agentManifest("@pkgorg/ver-res-agent"),
          content: "v2 prompt",
          lock_version: created.lock_version,
        }),
      });

      const res = await app.request("/api/packages/agents/@pkgorg/ver-res-agent/versions", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ version: "0.2.0" }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      // Full version detail resource, bare (same serializer as GET version
      // detail). `id` (version row id) and `version` are part of the resource.
      expect(body.id).toBeNumber();
      expect(body.version).toBe("0.2.0");
      expect(body.manifest).toBeDefined();
      expect(body.integrity).toBeString();
      expect(Array.isArray(body.dist_tags)).toBe(true);
      // No operation envelope.
      expect(body.message).toBeUndefined();
    });

    it("POST restore version returns the bare updated PACKAGE detail DTO", async () => {
      const create = await app.request("/api/packages/agents", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: agentManifest("@pkgorg/restore-res-agent"),
          content: "v1 prompt",
        }),
      });
      const created = (await create.json()) as any;

      const res = await app.request(
        "/api/packages/agents/@pkgorg/restore-res-agent/versions/0.1.0/restore",
        {
          method: "POST",
          headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      // A restore mutates the package draft — the response is the updated
      // PACKAGE resource (Agent detail), bare. The restored version is
      // reflected in the resource, and the resource carries the package's NEW
      // `lock_version`.
      expect(body.id).toBe("@pkgorg/restore-res-agent");
      expect(body.version).toBe("0.1.0");
      expect(body.manifest).toBeDefined();
      expect(body.lock_version).toBeGreaterThan(created.lock_version);
      // No operation envelope.
      expect(body.message).toBeUndefined();
      expect(body.restored_version).toBeUndefined();
    });

    it("POST fork returns the bare forked AGENT detail DTO (oneOf agent arm)", async () => {
      // Fork requires a source in ANOTHER org with a published version whose
      // ZIP exists in storage — go through the API end to end.
      const srcCtx = await createTestContext({ orgSlug: "forksrc" });
      const create = await app.request("/api/packages/agents", {
        method: "POST",
        headers: authHeaders(srcCtx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: agentManifest("@forksrc/forkable-agent"),
          content: "source prompt",
        }),
      });
      expect(create.status).toBe(201);
      // Create already auto-published 0.1.0 with byte-identical content, so an
      // explicit republish of the same version is a detected no-op (#896 made
      // this deterministic — it used to silently overwrite the artifact).
      const pub = await app.request("/api/packages/agents/@forksrc/forkable-agent/versions", {
        method: "POST",
        headers: authHeaders(srcCtx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ version: "0.1.0" }),
      });
      expect(pub.status).toBe(409);
      expect(((await pub.json()) as any).code).toBe("no_changes");

      const res = await app.request("/api/packages/@forksrc/forkable-agent/fork", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      // Bare forked Agent detail DTO — fork provenance is resource state.
      expect(body.id).toBe("@pkgorg/forkable-agent");
      expect(body.forked_from).toBe("@forksrc/forkable-agent");
      expect(body.manifest).toBeDefined();
      expect(body.lock_version).toBeDefined();
      // No operation envelope.
      expect(body.packageId).toBeUndefined();
      expect(body.type).toBeUndefined();
    });

    it("POST fork returns the bare forked SKILL detail DTO (oneOf non-agent arm)", async () => {
      const srcCtx = await createTestContext({ orgSlug: "forksrc2" });
      const create = await app.request("/api/packages/skills", {
        method: "POST",
        headers: authHeaders(srcCtx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: "@forksrc2/forkable-skill",
            version: "0.1.0",
            type: "skill",
            schema_version: "0.1",
            display_name: "Forkable Skill",
            description: "Skill arm of the fork oneOf",
          },
          content: "# Skill\nDo the thing.",
        }),
      });
      expect(create.status).toBe(201);
      // Same as the agent arm: create auto-published 0.1.0, the republish is a
      // detected no-op instead of a silent artifact overwrite (#896).
      const pub = await app.request("/api/packages/skills/@forksrc2/forkable-skill/versions", {
        method: "POST",
        headers: authHeaders(srcCtx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ version: "0.1.0" }),
      });
      expect(pub.status).toBe(409);
      expect(((await pub.json()) as any).code).toBe("no_changes");

      const res = await app.request("/api/packages/@forksrc2/forkable-skill/fork", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      // Bare forked OrgPackageItem detail DTO.
      expect(body.id).toBe("@pkgorg/forkable-skill");
      expect(body.forked_from).toBe("@forksrc2/forkable-skill");
      expect(body.lock_version).toBeDefined();
      // No operation envelope.
      expect(body.packageId).toBeUndefined();
      expect(body.type).toBeUndefined();
    });
  });
});
