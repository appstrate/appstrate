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
import {
  mcpServerManifest,
  remoteIntegrationManifest,
} from "../../helpers/integration-manifests.ts";
import {
  buildMinimalZip,
  uploadPackageZip,
  downloadVersionZip,
} from "../../../src/services/package-storage.ts";
import { unzipPackageArchive } from "../../../src/services/package-archive.ts";
import { computeIntegrity } from "@appstrate/core/integrity";
import { zipArtifact, PACKAGE_ZIP_MAX_COMPRESSED_BYTES } from "@appstrate/core/zip";
import { auditEvents, packages, packageDistTags, packageVersions } from "@appstrate/db/schema";
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

    // `source_code` was dropped from both JSON-body schemas once the last
    // reader died with the `tool` package type. Neither schema is `.strict()`,
    // so Zod strips the unknown key instead of rejecting it — a client still
    // sending it must keep working exactly as before (it was already a no-op:
    // no route config ever declared the `sourceFileName` that would have
    // written it). This pins that the removal did not tighten validation.
    it("still accepts a body carrying the retired source_code key", async () => {
      const createRes = await app.request("/api/packages/integrations", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: remoteIntegrationManifest("@pkgorg/legacy-source-code"),
          source_code: "export const unused = true;",
        }),
      });

      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as any;
      expect(created.source_code).toBeUndefined();

      const updateRes = await app.request("/api/packages/integrations/@pkgorg/legacy-source-code", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            ...remoteIntegrationManifest("@pkgorg/legacy-source-code"),
            display_name: "Renamed Integration",
          },
          source_code: "export const stillUnused = true;",
          lock_version: created.lock_version,
        }),
      });

      expect(updateRes.status).toBe(200);
      const updated = (await updateRes.json()) as any;
      expect(updated.source_code).toBeUndefined();
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

    // ── retired `runtime_tools` ids: direction decides ──────────
    //
    // Read the PERSISTED draft, not the response DTO: the defect is that the
    // handler validated one object and wrote another, so only the stored row
    // can prove which one landed.
    async function readDraftRuntimeTools(packageId: string): Promise<string[] | undefined> {
      const [row] = await db
        .select({ draftManifest: packages.draftManifest })
        .from(packages)
        .where(eq(packages.id, packageId))
        .limit(1);
      return (row!.draftManifest as { runtime_tools?: string[] }).runtime_tools;
    }
    //
    // The same handler serves two directions. A SUPPLIED manifest is author
    // input — an id the platform does not know is a mistake the author must
    // see. An OMITTED manifest carries the stored draft forward — a read, so a
    // legacy id is dropped rather than 400-ing a content-only save, and the
    // normalised shape is what gets written back.

    it("rejects an update whose manifest names a retired runtime tool", async () => {
      const agent = await seedAgent({
        id: "@pkgorg/retired-tool-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/agents/@pkgorg/retired-tool-agent", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: "@pkgorg/retired-tool-agent",
            version: "0.2.0",
            type: "agent",
            schema_version: "0.1",
            display_name: "Retired Tool Agent",
            runtime_tools: ["report", "log"],
          },
          content: "Updated prompt.",
          lock_version: agent.lockVersion,
        }),
      });

      expect(res.status).toBe(400);

      // Nothing was persisted — the draft is exactly as seeded.
      expect(await readDraftRuntimeTools("@pkgorg/retired-tool-agent")).toBeUndefined();
    });

    it("normalises a carried-forward draft that names a retired runtime tool", async () => {
      const id = "@pkgorg/legacy-tool-agent";
      const agent = await seedAgent({
        id,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: id,
          version: "0.1.0",
          type: "agent",
          schema_version: "0.1",
          display_name: "Legacy Tool Agent",
          runtime_tools: ["report", "log"],
        },
      });

      // Content-only save: no `manifest` in the body, so the stored draft is
      // carried forward. It must be written back VALIDATED, not raw.
      const res = await app.request(`/api/packages/agents/${id}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          content: "Only the prompt changed.",
          lock_version: agent.lockVersion,
        }),
      });

      expect(res.status).toBe(200);
      expect(await readDraftRuntimeTools(id)).toEqual(["log"]);
    });

    // ── retired AFPS 1.x dependency keys: same direction split (#1021) ──
    //
    // AFPS 1.x had `dependencies.tools` / `dependencies.providers`; AFPS 2.0
    // renamed them to `mcp_servers` / `integrations`. Every reader destructures
    // exactly the three canonical maps, so the retired spelling is INERT — it
    // used to validate and then be silently ignored, shipping an agent whose
    // declared dependency is never resolved. Author input must reject.
    async function putManifestDependencies(
      packageId: string,
      lockVersion: number | null | undefined,
      dependencies: Record<string, unknown>,
    ): Promise<Response> {
      return app.request(`/api/packages/agents/${packageId}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: packageId,
            version: "0.2.0",
            type: "agent",
            schema_version: "0.1",
            display_name: "Dependency Vocabulary Agent",
            dependencies,
          },
          content: "Updated prompt.",
          lock_version: lockVersion,
        }),
      });
    }

    it("rejects an update whose manifest declares dependencies.tools", async () => {
      const agent = await seedAgent({
        id: "@pkgorg/retired-dep-tools",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await putManifestDependencies("@pkgorg/retired-dep-tools", agent.lockVersion, {
        tools: { "@appstrate/report": "^1.0.0" },
      });

      expect(res.status).toBe(400);
      const body = JSON.stringify(await res.json());
      // The error must name the retired key AND its replacement — a bare
      // "invalid manifest" leaves the author with nowhere to go.
      expect(body).toContain("dependencies.tools");
      expect(body).toContain("dependencies.mcp_servers");

      // Not a partial write — the seeded draft is untouched.
      const [row] = await db
        .select({ draftManifest: packages.draftManifest })
        .from(packages)
        .where(eq(packages.id, "@pkgorg/retired-dep-tools"))
        .limit(1);
      expect((row!.draftManifest as Record<string, unknown>).dependencies).toBeUndefined();
    });

    it("rejects an update whose manifest declares dependencies.providers", async () => {
      const agent = await seedAgent({
        id: "@pkgorg/retired-dep-providers",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await putManifestDependencies(
        "@pkgorg/retired-dep-providers",
        agent.lockVersion,
        { providers: { "@appstrate/gmail": "^1.0.0" } },
      );

      expect(res.status).toBe(400);
      const body = JSON.stringify(await res.json());
      expect(body).toContain("dependencies.providers");
      expect(body).toContain("dependencies.integrations");
    });

    it("accepts the canonical dependency maps and an unrelated extension key", async () => {
      // Control: the rejects above are caused by the retired KEYS, not by the
      // mere presence of `dependencies`. `dependencies` stays a loose object
      // (AFPS §10 extensibility) — closing it is explicitly NOT the fix.
      const id = "@pkgorg/canonical-deps";
      const agent = await seedAgent({ id, orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await putManifestDependencies(id, agent.lockVersion, {
        skills: {},
        mcp_servers: {},
        integrations: {},
        _meta: { "dev.appstrate/note": "still legal" },
      });

      expect(res.status).toBe(200);
      const [row] = await db
        .select({ draftManifest: packages.draftManifest })
        .from(packages)
        .where(eq(packages.id, id))
        .limit(1);
      const deps = (row!.draftManifest as Record<string, unknown>).dependencies as Record<
        string,
        unknown
      >;
      expect(deps._meta).toEqual({ "dev.appstrate/note": "still legal" });
    });

    it("carries a stored draft with a retired dependency key forward untouched", async () => {
      // Read direction: a draft written before the guard existed must stay
      // editable. A content-only save carries it forward — tolerated, and NOT
      // rewritten (this validator never mutates stored bytes).
      const id = "@pkgorg/legacy-dep-agent";
      const agent = await seedAgent({
        id,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: id,
          version: "0.1.0",
          type: "agent",
          schema_version: "0.1",
          display_name: "Legacy Dep Agent",
          dependencies: { tools: { "@appstrate/report": "^1.0.0" } },
        },
      });

      const res = await app.request(`/api/packages/agents/${id}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          content: "Only the prompt changed.",
          lock_version: agent.lockVersion,
        }),
      });

      expect(res.status).toBe(200);
      const [row] = await db
        .select({ draftManifest: packages.draftManifest })
        .from(packages)
        .where(eq(packages.id, id))
        .limit(1);
      expect((row!.draftManifest as Record<string, unknown>).dependencies).toEqual({
        tools: { "@appstrate/report": "^1.0.0" },
      });
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

    function gmailIntegrationManifest(
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return {
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
        ...overrides,
      };
    }

    /**
     * Seed the test integration as a DRAFT **and** as published `1.0.0`. The
     * published row is load-bearing: the gate judges the PINNED manifest, so a
     * draft-only integration is never judged at all.
     */
    async function seedGmailIntegration(opts: { draftManifest?: Record<string, unknown> } = {}) {
      await seedPackage({
        id: integrationId,
        orgId: ctx.orgId,
        type: "integration",
        source: "local",
        draftManifest: opts.draftManifest ?? gmailIntegrationManifest(),
      });
      await seedPackageVersion({
        packageId: integrationId,
        version: "1.0.0",
        manifest: gmailIntegrationManifest(),
      });
    }

    // A serverless api_call integration that declares `default_tools` — the
    // shape the ~60 system integrations use, where adding the dependency alone
    // already yields a callable surface.
    const defaultsIntegrationId = "@pkgorg/with-defaults";

    function defaultsIntegrationManifest(
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return {
        type: "integration",
        schema_version: "0.1",
        name: defaultsIntegrationId,
        version: "1.0.0",
        display_name: "Defaults (test)",
        source: { kind: "none" },
        default_tools: ["api_call"],
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
          },
        },
        _meta: { "dev.appstrate/api": { auths: { primary: {} } } },
        ...overrides,
      };
    }

    /**
     * Seed the defaults integration with an INDEPENDENT draft and published
     * manifest, so a test can make the two disagree.
     */
    async function seedDefaultsIntegration(opts: {
      draftManifest?: Record<string, unknown>;
      publishedManifest?: Record<string, unknown>;
    }) {
      await seedPackage({
        id: defaultsIntegrationId,
        orgId: ctx.orgId,
        type: "integration",
        source: "local",
        draftManifest: opts.draftManifest ?? defaultsIntegrationManifest(),
      });
      await seedPackageVersion({
        packageId: defaultsIntegrationId,
        version: "1.0.0",
        manifest: opts.publishedManifest ?? defaultsIntegrationManifest(),
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

    // ── Declared-but-empty gate (`requireCallableTools`) ────────────────
    // A declared integration whose EFFECTIVE selection is empty exposes
    // nothing callable, so it is refused where the artifact is frozen
    // (publish, import) — and deliberately NOT on the draft writes the
    // editor autosaves through.

    /** Seed a draft that declares `integrationId` with the given selection. */
    async function seedDraftDeclaring(
      id: string,
      config: Record<string, unknown> | undefined,
    ): Promise<void> {
      await seedPackage({
        id,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: id,
          version: "1.0.0",
          type: "agent",
          schema_version: "0.2",
          display_name: "Zero tools",
          description: "Declares an integration",
          dependencies: { integrations: { [integrationId]: "^1.0.0" } },
          ...(config ? { integrations_configuration: { [integrationId]: config } } : {}),
        },
        draftContent: "Prompt.",
      });
    }

    it("draft POST accepts a declared integration with an explicitly empty tool selection", async () => {
      // The editor's own flow: the dependency is added first, the tools are
      // ticked after. Blocking the save here would make the editor unusable.
      await seedGmailIntegration();
      const res = await app.request("/api/packages/agents", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify(buildAgentBody({ version: "^1.0.0", tools: [] }, "empty-draft")),
      });
      expect(res.status).toBe(201);
    });

    it("create does NOT freeze an initial version when the manifest would be refused at publish", async () => {
      // The create route accepts the empty state (previous test) but then
      // snapshots the draft into an IMMUTABLE version. Asserting only the 201
      // is what hid this: the artifact the publish route refuses was being
      // frozen anyway, one call earlier.
      await seedGmailIntegration();
      const res = await app.request("/api/packages/agents", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify(buildAgentBody({ version: "^1.0.0", tools: [] }, "no-frozen-version")),
      });
      expect(res.status).toBe(201);

      const frozen = await db
        .select()
        .from(packageVersions)
        .where(eq(packageVersions.packageId, "@pkgorg/agent-no-frozen-version"));
      expect(frozen).toHaveLength(0);
    });

    it("create DOES freeze an initial version when the selection is callable", async () => {
      // Positive control for the test above — without it, a snapshot that
      // never happens for an unrelated reason would read as a passing gate.
      await seedGmailIntegration();
      const res = await app.request("/api/packages/agents", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify(
          buildAgentBody({ version: "^1.0.0", tools: ["list_messages"] }, "frozen-version-ok"),
        ),
      });
      expect(res.status).toBe(201);

      const frozen = await db
        .select()
        .from(packageVersions)
        .where(eq(packageVersions.packageId, "@pkgorg/agent-frozen-version-ok"));
      expect(frozen).toHaveLength(1);
    });

    it("draft PUT accepts a declared integration with an explicitly empty tool selection", async () => {
      await seedGmailIntegration();
      const agent = await seedAgent({
        id: "@pkgorg/agent-put-empty",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      const res = await app.request("/api/packages/agents/@pkgorg/agent-put-empty", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: {
            name: "@pkgorg/agent-put-empty",
            version: "0.2.0",
            type: "agent",
            schema_version: "0.2",
            display_name: "Updated",
            dependencies: { integrations: { [integrationId]: "^1.0.0" } },
            integrations_configuration: { [integrationId]: { tools: [] } },
          },
          content: "Updated prompt",
          lock_version: agent.lockVersion,
        }),
      });
      expect(res.status).toBe(200);
    });

    it("publish judges the tool catalog on the PINNED version, not the integration's draft", async () => {
      // The failure this closes: the integration's author adds a tool to their
      // draft, an agent pinned to ^1.0.0 selects it, publish passes because the
      // subset check read the draft — and the run registers nothing, because
      // the pinned v1.0.0 never advertised it. Judging emptiness on the pinned
      // manifest while judging the catalog on the draft was incoherent.
      await seedPackage({
        id: integrationId,
        orgId: ctx.orgId,
        type: "integration",
        source: "local",
        // The DRAFT knows `archive_thread`…
        draftManifest: gmailIntegrationManifest({
          tools_policy: {
            list_messages: { required_scopes: { primary: ["read"] } },
            archive_thread: { required_scopes: { primary: ["read"] } },
          },
        }),
      });
      // …the PINNED v1.0.0 does not.
      await seedPackageVersion({
        packageId: integrationId,
        version: "1.0.0",
        manifest: gmailIntegrationManifest(),
      });
      await seedDraftDeclaring("@pkgorg/publish-draft-only-tool", { tools: ["archive_thread"] });

      const res = await app.request(
        "/api/packages/agents/@pkgorg/publish-draft-only-tool/versions",
        {
          method: "POST",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors?: { code: string; field: string }[] };
      const codes = (body.errors ?? []).map((e) => e.code);
      expect(codes).toContain("unknown_tool");
    });

    it("publish judges a local integration's mcp-server catalog on its RESOLVED version, not its draft", async () => {
      // One level deeper than the test above. A `source.kind: "local"`
      // integration takes its tool catalog from a separate mcp-server package,
      // and the spawn resolver reads that package at the version
      // `source.server.version` resolves to. The validator read
      // `packages.draft_manifest` instead, which the runtime never does.
      //
      // Asserted in the ACCEPT direction on purpose: a tool present in the
      // PUBLISHED mcp-server but absent from its author's draft must publish
      // cleanly, because the run will find it. A refusal here can only come
      // from reading the draft — whereas a rejection test would also pass for
      // the unrelated reason that an unreadable draft falls back to the
      // integration's own `tools_policy`.
      const serverId = "@pkgorg/gmail-server";
      // Built through the shared helper: a hand-written manifest failed
      // `mcpServerManifestSchema` (it wants manifest_version 0.3 and
      // `server.mcp_config`), the resolver returned null, and the catalog fell
      // back to the integration's own `tools_policy` — a green-looking test
      // that exercised neither read path.
      const serverManifest = (tools: string[], version: string) => ({
        ...mcpServerManifest({ name: serverId, version }),
        tools: tools.map((name) => ({ name })),
      });
      await seedPackage({
        id: serverId,
        orgId: ctx.orgId,
        type: "mcp-server",
        source: "local",
        // The DRAFT has dropped `archive_thread`…
        draftManifest: serverManifest(["list_messages"], "1.1.0"),
      });
      // …the PUBLISHED 1.0.0 the integration pins still advertises it.
      await seedPackageVersion({
        packageId: serverId,
        version: "1.0.0",
        manifest: serverManifest(["list_messages", "archive_thread"], "1.0.0"),
      });
      const localIntegrationManifest = gmailIntegrationManifest({
        source: { kind: "local", server: { name: serverId, version: "1.0.0" } },
      });
      await seedPackage({
        id: integrationId,
        orgId: ctx.orgId,
        type: "integration",
        source: "local",
        draftManifest: localIntegrationManifest,
      });
      await seedPackageVersion({
        packageId: integrationId,
        version: "1.0.0",
        manifest: localIntegrationManifest,
      });
      await seedDraftDeclaring("@pkgorg/publish-server-published-tool", {
        tools: ["archive_thread"],
      });

      const res = await app.request(
        "/api/packages/agents/@pkgorg/publish-server-published-tool/versions",
        {
          method: "POST",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      expect(res.status).toBe(201);
    });

    it("publish refuses a NON-EMPTY selection whose every tool is hidden", async () => {
      // "Non-empty" and "callable" are different properties, and only the second
      // is the boot contract. `default_tools: ["list_messages"]` with
      // `hidden_tools: ["list_messages"]` is a selection of length 1 that
      // registers nothing — a length check waves it through and the run aborts.
      const manifest = gmailIntegrationManifest({
        default_tools: ["list_messages"],
        hidden_tools: ["list_messages"],
        tools_policy: { list_messages: { required_scopes: { primary: ["read"] } } },
      });
      await seedPackage({
        id: integrationId,
        orgId: ctx.orgId,
        type: "integration",
        source: "local",
        draftManifest: manifest,
      });
      await seedPackageVersion({ packageId: integrationId, version: "1.0.0", manifest });
      // No explicit selection — the agent inherits `default_tools`, so this is
      // the path the subset check never sees.
      await seedDraftDeclaring("@pkgorg/publish-all-hidden", undefined);

      const res = await app.request("/api/packages/agents/@pkgorg/publish-all-hidden/versions", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors?: { code: string }[] };
      expect((body.errors ?? []).map((e) => e.code)).toContain("no_tools_selected");
    });

    it("publish refuses wildcard when a known catalog is entirely hidden", async () => {
      const serverId = "@pkgorg/gmail-server";
      const server = {
        ...mcpServerManifest({ name: serverId, version: "1.0.0" }),
        tools: [{ name: "list_messages" }],
      };
      await seedPackage({
        id: serverId,
        orgId: ctx.orgId,
        type: "mcp-server",
        source: "local",
        draftManifest: server,
      });
      await seedPackageVersion({ packageId: serverId, version: "1.0.0", manifest: server });

      const manifest = gmailIntegrationManifest({
        source: { kind: "local", server: { name: serverId, version: "1.0.0" } },
        allow_undeclared_tools: true,
        hidden_tools: ["list_messages"],
        tools_policy: { list_messages: { required_scopes: { primary: ["read"] } } },
      });
      const primary = (manifest.auths as Record<string, Record<string, unknown>>).primary!;
      primary.default_scopes = ["read"];
      await seedPackage({
        id: integrationId,
        orgId: ctx.orgId,
        type: "integration",
        source: "local",
        draftManifest: manifest,
      });
      await seedPackageVersion({ packageId: integrationId, version: "1.0.0", manifest });
      await seedDraftDeclaring("@pkgorg/publish-wildcard-all-hidden", { tools: "*" });

      const res = await app.request(
        "/api/packages/agents/@pkgorg/publish-wildcard-all-hidden/versions",
        {
          method: "POST",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors?: { code: string }[] };
      expect((body.errors ?? []).map((e) => e.code)).toContain("no_tools_selected");
    });

    it("publish refuses a draft whose declared integration selects no tool", async () => {
      await seedGmailIntegration();
      await seedDraftDeclaring("@pkgorg/publish-empty-tools", { tools: [] });

      const res = await app.request("/api/packages/agents/@pkgorg/publish-empty-tools/versions", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        errors?: { code: string; field: string; message: string }[];
      };
      expect(body.errors?.[0]?.code).toBe("no_tools_selected");
      expect(body.errors?.[0]?.field).toBe(`integrations_configuration.${integrationId}.tools`);
      // The message must name BOTH ways out, not just the checkbox.
      expect(body.errors?.[0]?.message).toContain("Select at least one tool");
      expect(body.errors?.[0]?.message).toContain("dependencies.integrations");
    });

    it("publish refuses a draft that declares an integration with no configuration entry at all", async () => {
      // No `integrations_configuration` block: the selection is undefined and
      // this integration declares no `default_tools`, so it resolves to empty.
      await seedGmailIntegration();
      await seedDraftDeclaring("@pkgorg/publish-no-config", undefined);

      const res = await app.request("/api/packages/agents/@pkgorg/publish-no-config/versions", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors?: { code: string }[] };
      expect(body.errors?.[0]?.code).toBe("no_tools_selected");
    });

    it("publish accepts a draft once a tool is selected", async () => {
      await seedGmailIntegration();
      await seedDraftDeclaring("@pkgorg/publish-with-tool", { tools: ["list_messages"] });

      const res = await app.request("/api/packages/agents/@pkgorg/publish-with-tool/versions", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBeLessThan(300);
    });

    it("publish accepts an unspecified selection when the integration declares default_tools", async () => {
      // `tools` absent is NOT `tools: []` — it inherits `default_tools`
      // (AFPS §4.4), which is what the ~60 api_call system integrations rely
      // on. Publishing must not break the "add it and go" flow for those.
      await seedDefaultsIntegration({});
      await seedPackage({
        id: "@pkgorg/publish-inherits-default",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@pkgorg/publish-inherits-default",
          version: "1.0.0",
          type: "agent",
          schema_version: "0.2",
          display_name: "Inherits default",
          description: "No explicit selection",
          dependencies: { integrations: { [defaultsIntegrationId]: "^1.0.0" } },
        },
        draftContent: "Prompt.",
      });

      const res = await app.request(
        "/api/packages/agents/@pkgorg/publish-inherits-default/versions",
        {
          method: "POST",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      expect(res.status).toBeLessThan(300);
    });

    it("publish judges the PINNED integration manifest, not the integration author's draft", async () => {
      // v1.0.0 declares `default_tools: ["api_call"]`, so the agent's absent
      // selection inherits a callable tool and the run works — while the
      // integration author's CURRENT draft has dropped `default_tools`.
      // Judging the draft would 400 a publish the runtime runs perfectly.
      const draftWithoutDefaults = defaultsIntegrationManifest();
      delete draftWithoutDefaults.default_tools;
      await seedDefaultsIntegration({
        draftManifest: draftWithoutDefaults,
        publishedManifest: defaultsIntegrationManifest(),
      });
      await seedPackage({
        id: "@pkgorg/publish-pinned-defaults",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@pkgorg/publish-pinned-defaults",
          version: "1.0.0",
          type: "agent",
          schema_version: "0.2",
          display_name: "Pinned defaults",
          description: "No explicit selection",
          dependencies: { integrations: { [defaultsIntegrationId]: "^1.0.0" } },
        },
        draftContent: "Prompt.",
      });

      const res = await app.request(
        "/api/packages/agents/@pkgorg/publish-pinned-defaults/versions",
        {
          method: "POST",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      if (res.status >= 300) {
        throw new Error(`expected publish to succeed, got ${res.status}: ${await res.text()}`);
      }
    });

    it("publish reports the empty selection AND the bad scope in one pass", async () => {
      // `{ tools: [], scopes: ["bogus"] }` reaches the configured-entry filter
      // on `scopes.length > 0` alone, so both checks apply.
      await seedGmailIntegration();
      await seedPackage({
        id: "@pkgorg/publish-empty-and-bad-scope",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@pkgorg/publish-empty-and-bad-scope",
          version: "1.0.0",
          type: "agent",
          schema_version: "0.2",
          display_name: "Empty tools, bogus scope",
          description: "Two problems, one entry",
          dependencies: { integrations: { [integrationId]: "^1.0.0" } },
          integrations_configuration: { [integrationId]: { tools: [], scopes: ["bogus"] } },
        },
        draftContent: "Prompt.",
      });

      const res = await app.request(
        "/api/packages/agents/@pkgorg/publish-empty-and-bad-scope/versions",
        {
          method: "POST",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors?: { code: string; field: string }[] };
      const codes = (body.errors ?? []).map((e) => e.code);
      expect(codes).toContain("no_tools_selected");
      expect(codes).toContain("scope_not_in_catalog");
    });

    it("ZIP import refuses an agent whose declared integration selects no tool", async () => {
      await seedGmailIntegration();
      const enc = (s: string) => new TextEncoder().encode(s);
      const afps = zipSync({
        "manifest.json": enc(
          JSON.stringify({
            name: "@pkgorg/imported-empty-tools",
            version: "1.0.0",
            type: "agent",
            schema_version: "0.2",
            display_name: "Imported empty",
            description: "Declared but empty",
            dependencies: { integrations: { [integrationId]: "^1.0.0" } },
            integrations_configuration: { [integrationId]: { tools: [] } },
          }),
        ),
        "prompt.md": enc("Prompt."),
      });
      const formData = new FormData();
      formData.append("file", new File([new Uint8Array(afps)], "agent.afps"));

      const res = await app.request("/api/packages/import", {
        method: "POST",
        headers: authHeaders(ctx),
        body: formData,
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors?: { code: string }[] };
      expect(body.errors?.[0]?.code).toBe("no_tools_selected");
      await assertDbMissing(packages, eq(packages.id, "@pkgorg/imported-empty-tools"));
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

    // ── retired `runtime_tools` policy: /import is the WRITE direction ──
    //
    // `/import` (and `/import-github`, which shares the same parse helper) is
    // author input, NOT content the platform already holds — so a retired id
    // and a typo both reject, with a field-precise error the operator can fix
    // by editing one line of manifest.json. Contrast
    // `POST /api/packages/import-bundle`, which drops (see
    // packages-import-bundle.test.ts). If this pair ever starts returning 201,
    // the policy has silently flipped and typos are being swallowed.
    async function importAgentWithRuntimeTools(tools: string[]): Promise<Response> {
      const enc = (s: string) => new TextEncoder().encode(s);
      const afps = zipSync({
        "manifest.json": enc(
          JSON.stringify({
            name: "@pkgorg/rt-policy-agent",
            version: "1.0.0",
            type: "agent",
            schema_version: "0.1",
            display_name: "Runtime Tools Policy Agent",
            runtime_tools: tools,
          }),
        ),
        "prompt.md": enc("You are an agent."),
      });
      const formData = new FormData();
      formData.append("file", new File([new Uint8Array(afps)], "agent.afps"));
      return app.request("/api/packages/import", {
        method: "POST",
        headers: authHeaders(ctx),
        body: formData,
      });
    }

    it("returns 400 for a RETIRED runtime_tools id (author input rejects)", async () => {
      const res = await importAgentWithRuntimeTools(["output", "report"]);
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(JSON.stringify(body)).toContain("runtime_tools");

      // Nothing was persisted — the reject is not a partial write.
      const [row] = await db
        .select({ id: packages.id })
        .from(packages)
        .where(eq(packages.id, "@pkgorg/rt-policy-agent"))
        .limit(1);
      expect(row).toBeUndefined();
    });

    it("returns 400 for a MISSPELLED runtime_tools id (author input rejects)", async () => {
      const res = await importAgentWithRuntimeTools(["lgo"]);
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(JSON.stringify(body)).toContain("runtime_tools");
    });

    // Same WRITE direction, applied to the retired AFPS 1.x dependency keys
    // (#1021). An uploaded .afps is author input and locally repairable — the
    // error names the key and its replacement, so the operator edits one line.
    it("returns 400 for a retired dependencies key (author input rejects)", async () => {
      const enc = (s: string) => new TextEncoder().encode(s);
      const afps = zipSync({
        "manifest.json": enc(
          JSON.stringify({
            name: "@pkgorg/dep-vocab-agent",
            version: "1.0.0",
            type: "agent",
            schema_version: "0.1",
            display_name: "Dependency Vocabulary Agent",
            dependencies: { tools: { "@appstrate/report": "^1.0.0" } },
          }),
        ),
        "prompt.md": enc("You are an agent."),
      });
      const formData = new FormData();
      formData.append("file", new File([new Uint8Array(afps)], "agent.afps"));
      const res = await app.request("/api/packages/import", {
        method: "POST",
        headers: authHeaders(ctx),
        body: formData,
      });

      expect(res.status).toBe(400);
      const body = JSON.stringify(await res.json());
      expect(body).toContain("dependencies.tools");
      expect(body).toContain("dependencies.mcp_servers");

      // Nothing was persisted — the reject is not a partial write.
      const [row] = await db
        .select({ id: packages.id })
        .from(packages)
        .where(eq(packages.id, "@pkgorg/dep-vocab-agent"))
        .limit(1);
      expect(row).toBeUndefined();
    });

    it("imports an agent whose runtime_tools are all still selectable", async () => {
      // Control: the reject above must be caused by the id, not by the mere
      // presence of `runtime_tools`.
      const res = await importAgentWithRuntimeTools(["output", "log"]);
      expect(res.status).toBe(201);
      const [row] = await db
        .select({ draftManifest: packages.draftManifest })
        .from(packages)
        .where(eq(packages.id, "@pkgorg/rt-policy-agent"))
        .limit(1);
      expect((row!.draftManifest as Record<string, unknown>).runtime_tools).toEqual([
        "output",
        "log",
      ]);
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

  // ═══════════════════════════════════════════════
  // Issue #974 — a fork is a READ that MINTS: it copies an already-published
  // (immutable, unrepairable) manifest into a brand new version row + ZIP.
  // The normalisation therefore has to happen ONCE, before the draft row is
  // written, so the three sinks — draft row, draft storage files, published
  // version (row + ZIP) — can never disagree.
  // ═══════════════════════════════════════════════

  describe("POST fork — published manifest normalisation", () => {
    /**
     * Seed a PUBLISHED source package in another org WITHOUT going through the
     * API: the write direction rejects a retired `runtime_tools` id, so the
     * legacy state a fork must cope with can only be produced by writing the
     * row + artifact directly.
     */
    async function seedPublishedSource(
      packageId: string,
      orgId: string,
      manifest: Record<string, unknown>,
      content = "source prompt",
      /**
       * The `packages.type` COLUMN, for the case where it deliberately
       * DISAGREES with `manifest.type` — the drift the #481
       * provider→integration migration left in the catalog. Defaults to the
       * manifest's own type (the aligned, ordinary case).
       */
      rowType?: "agent" | "skill" | "integration" | "mcp-server",
    ): Promise<void> {
      const version = manifest.version as string;
      const type = rowType ?? (manifest.type as "agent" | "skill");
      await seedPackage({
        id: packageId,
        orgId,
        type,
        draftManifest: manifest,
        draftContent: content,
      });
      const zip = buildMinimalZip(manifest, content, type === "skill" ? "SKILL.md" : "prompt.md");
      await uploadPackageZip(packageId, version, zip);
      const row = await seedPackageVersion({
        packageId,
        version,
        manifest,
        integrity: computeIntegrity(new Uint8Array(zip)),
        artifactSize: zip.byteLength,
      });
      await db.insert(packageDistTags).values({ packageId, tag: "latest", versionId: row.id });
    }

    async function versionManifest(packageId: string): Promise<Record<string, unknown>> {
      const [row] = await db
        .select({ manifest: packageVersions.manifest })
        .from(packageVersions)
        .where(eq(packageVersions.packageId, packageId))
        .limit(1);
      return row!.manifest as Record<string, unknown>;
    }

    async function draftManifest(packageId: string): Promise<Record<string, unknown>> {
      const [row] = await db
        .select({ draftManifest: packages.draftManifest })
        .from(packages)
        .where(eq(packages.id, packageId))
        .limit(1);
      return row!.draftManifest as Record<string, unknown>;
    }

    /** Raw `manifest.json` text out of the published artifact — the bytes a
     *  pinned run reads, which the DB row alone cannot prove. */
    async function artifactManifestText(packageId: string, version: string): Promise<string> {
      const zip = await downloadVersionZip(packageId, version);
      expect(zip).not.toBeNull();
      const entries = unzipPackageArchive(zip!);
      return new TextDecoder().decode(entries["manifest.json"]!);
    }

    it("drops a retired runtime tool from all three fork sinks", async () => {
      const srcCtx = await createTestContext({ orgSlug: "forkret" });
      const sourceId = "@forkret/legacy-agent";
      await seedPublishedSource(sourceId, srcCtx.orgId, {
        name: sourceId,
        version: "0.1.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "Legacy Tool Agent",
        description: "Published before `report` was retired",
        runtime_tools: ["output", "report"],
      });

      const res = await app.request(`/api/packages/${sourceId}/fork`, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);

      const targetId = "@pkgorg/legacy-agent";
      // 1. the new catalog row
      expect((await versionManifest(targetId)).runtime_tools).toEqual(["output"]);
      // 2. the fork's draft — leave the retired id here and the fork's first
      //    re-publish regraves it into yet another immutable artifact.
      expect((await draftManifest(targetId)).runtime_tools).toEqual(["output"]);
      // 3. the immutable artifact — a normalised row over a stale ZIP still
      //    ships the retired id to every runner that downloads the bundle.
      const zipped = JSON.parse(await artifactManifestText(targetId, "0.1.0")) as {
        runtime_tools?: string[];
      };
      expect(zipped.runtime_tools).toEqual(["output"]);
    });

    it("removes the runtime_tools key entirely when every tool was retired", async () => {
      const srcCtx = await createTestContext({ orgSlug: "forkret2" });
      const sourceId = "@forkret2/all-retired";
      await seedPublishedSource(sourceId, srcCtx.orgId, {
        name: sourceId,
        version: "0.1.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "All Retired",
        description: "Its only runtime tool no longer exists",
        runtime_tools: ["report"],
      });

      const res = await app.request(`/api/packages/${sourceId}/fork`, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);

      // ABSENT, not `[]`: absent and `[]` parse to the same agent but are
      // different bytes, and the editor spells "no runtime tools" as absent.
      // Emitting `[]` here would give one manifest two integrity hashes.
      const targetId = "@pkgorg/all-retired";
      expect(await versionManifest(targetId)).not.toHaveProperty("runtime_tools");
      expect(await draftManifest(targetId)).not.toHaveProperty("runtime_tools");
      const zipped = JSON.parse(await artifactManifestText(targetId, "0.1.0")) as Record<
        string,
        unknown
      >;
      expect(zipped).not.toHaveProperty("runtime_tools");
    });

    it("forks a clean manifest unchanged — nothing reordered, nothing defaulted", async () => {
      const srcCtx = await createTestContext({ orgSlug: "forkclean" });
      const sourceId = "@forkclean/clean-agent";
      await seedPublishedSource(sourceId, srcCtx.orgId, {
        name: sourceId,
        version: "0.1.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "Clean Agent",
        description: "Nothing to drop",
        runtime_tools: ["output", "log"],
      });

      const res = await app.request(`/api/packages/${sourceId}/fork`, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);

      // FORWARD guard, not a proof of the fix: `dropRetiredRuntimeTools`
      // returns the same object reference when there is nothing to drop, so
      // this passed before the normalisation existed too. What it pins is the
      // shape of any FUTURE normalisation added here — a Zod re-parse would
      // reorder keys to schema order and materialise defaults, giving one
      // manifest two integrity hashes and defeating publish dedup (#896). A
      // source with nothing to drop must serialise to the source manifest with
      // ONLY `name` swapped. Compared against the STORED source manifest (not
      // the literal above) because jsonb does not preserve authoring key order.
      const targetId = "@pkgorg/clean-agent";
      const expected = JSON.stringify(
        { ...(await versionManifest(sourceId)), name: targetId },
        null,
        2,
      );
      expect(await artifactManifestText(targetId, "0.1.0")).toBe(expected);
    });

    it("is a no-op for a non-agent package — a skill forks with only `name` swapped", async () => {
      // `runtime_tools` is agent vocabulary, so the normalisation must be
      // invisible to the other three package types.
      const srcCtx = await createTestContext({ orgSlug: "forkskill" });
      const sourceId = "@forkskill/plain-skill";
      await seedPublishedSource(
        sourceId,
        srcCtx.orgId,
        {
          name: sourceId,
          version: "0.1.0",
          type: "skill",
          schema_version: "0.1",
          display_name: "Plain Skill",
          description: "Nothing an agent-shaped normalisation could touch",
        },
        "# Plain Skill",
      );

      const res = await app.request(`/api/packages/${sourceId}/fork`, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);

      const targetId = "@pkgorg/plain-skill";
      const expected = { ...(await versionManifest(sourceId)), name: targetId };
      expect(await versionManifest(targetId)).toEqual(expected);
      expect(await artifactManifestText(targetId, "0.1.0")).toBe(JSON.stringify(expected, null, 2));
      // `toMatchObject`, not `toEqual`: every draft row gets `$schema` + `type`
      // stamped by `createOrgItem` regardless of package type — pre-existing,
      // unrelated to this normalisation. What matters here is that nothing the
      // source declared was changed or lost.
      expect(await draftManifest(targetId)).toMatchObject(expected);
    });

    // Issue #987 made `createOrgItem` REFUSE a manifest whose `type` disagrees
    // with the package type instead of silently rewriting it. A fork is the one
    // caller whose two sources can legitimately disagree — the config comes
    // from the `packages.type` COLUMN, the manifest from an immutable published
    // snapshot — so it normalizes explicitly before calling. Without that, the
    // `type: "provider"` rows the #481 migration left in the catalog would fork
    // into a 500.
    it("forks a published manifest whose type drifted from its row (#481 legacy)", async () => {
      const srcCtx = await createTestContext({ orgSlug: "forkdrift" });
      const sourceId = "@forkdrift/legacy-provider";
      await seedPublishedSource(
        sourceId,
        srcCtx.orgId,
        {
          name: sourceId,
          version: "0.1.0",
          // The pre-#481 vocabulary: a type no schema accepts today, on a row
          // the migration retyped to `integration`.
          type: "provider",
          schema_version: "0.1",
          display_name: "Legacy Provider",
          description: "Left behind by the provider→integration migration",
        },
        "",
        "integration",
      );

      const res = await app.request(`/api/packages/${sourceId}/fork`, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({}),
      });

      // 201, NOT a 500 from the new invariant: the drifted source stays forkable.
      expect(res.status).toBe(201);

      const targetId = "@pkgorg/legacy-provider";
      const [row] = await db
        .select({ type: packages.type })
        .from(packages)
        .where(eq(packages.id, targetId))
        .limit(1);
      expect(row!.type).toBe("integration");
      // The fork's draft AND its new immutable version row agree with the row
      // type — previously only the draft got the rewrite, so the version row
      // (and the ZIP built from the same object) kept `provider`.
      expect((await draftManifest(targetId)).type).toBe("integration");
      expect((await versionManifest(targetId)).type).toBe("integration");
      const zipped = JSON.parse(await artifactManifestText(targetId, "0.1.0")) as {
        type?: string;
      };
      expect(zipped.type).toBe("integration");
    });
  });

  // ═══════════════════════════════════════════════
  // POST fork — `packages.draft_content`, the FOURTH writer of the
  // "which archive entry is this type's primary content" fact. Import
  // (`parsePackageZip`), the file explorer's overlay and the package UI all
  // read it from `PACKAGE_CONTENT_ENTRY`; the fork read a hardcoded
  // `prompt.md`/`SKILL.md` pair, so it covered two of the four types and
  // produced `""` for the other two — a column NO import of the same bytes
  // could ever produce.
  // ═══════════════════════════════════════════════

  describe("POST fork — draft_content comes from PACKAGE_CONTENT_ENTRY", () => {
    const INTEGRATION_DOC = "# Forkable\n\nAgent-facing docs shipped by the bundle.\n";

    /** Publish an integration in another org, with whatever companion entries. */
    async function publishIntegration(
      packageId: string,
      orgId: string,
      companions: Record<string, Uint8Array>,
    ): Promise<void> {
      const manifest = remoteIntegrationManifest({
        name: packageId,
        version: "0.1.0",
        auths: {},
      }) as unknown as Record<string, unknown>;
      await seedPackage({
        id: packageId,
        orgId,
        type: "integration",
        draftManifest: manifest,
        // What an IMPORT of these bytes stores: the doc when there is one, the
        // manifest text otherwise. The source row is deliberately correct so
        // the fork is the only thing under test.
        draftContent: companions["INTEGRATION.md"]
          ? new TextDecoder().decode(companions["INTEGRATION.md"])
          : JSON.stringify(manifest, null, 2),
      });
      const zip = Buffer.from(
        zipArtifact(
          {
            "manifest.json": new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
            ...companions,
          },
          6,
        ),
      );
      await uploadPackageZip(packageId, "0.1.0", zip);
      const row = await seedPackageVersion({
        packageId,
        version: "0.1.0",
        manifest,
        integrity: computeIntegrity(new Uint8Array(zip)),
        artifactSize: zip.byteLength,
      });
      await db.insert(packageDistTags).values({ packageId, tag: "latest", versionId: row.id });
    }

    async function forkInto(sourceId: string, targetId: string): Promise<void> {
      const res = await app.request(`/api/packages/${sourceId}/fork`, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
      // Pin the id the rest of the test reads its rows by — a change in how the
      // route derives it would otherwise surface as "row not found".
      expect(((await res.json()) as { id: string }).id).toBe(targetId);
      // The route auto-installs the fork in the calling application, which is
      // what satisfies the explorer's `hasPackageAccess` gate below — so no
      // install of our own, which would 409 as `already_installed`. The `200`
      // asserted in `fileIndex` is the proof that it happened.
    }

    async function draftContentOf(packageId: string): Promise<string | null> {
      const [row] = await db
        .select({ draftContent: packages.draftContent })
        .from(packages)
        .where(eq(packages.id, packageId))
        .limit(1);
      return row!.draftContent;
    }

    /**
     * The explorer index. The route lives at the packages router ROOT —
     * `/api/packages/{scope}/{name}/files`, with NO per-type segment, because
     * its RBAC resource comes from the package row rather than the path (see
     * `loadFileExplorerPackage`). Inserting `integrations/` makes
     * `SCOPED_PACKAGE_ROUTE` fail to match `:scope{@…}` and Hono answers 404
     * before any handler runs — a routing miss that looks exactly like the
     * app-install 404 this suite would otherwise be probing.
     */
    async function fileIndex(
      packageId: string,
    ): Promise<{ path: string; size: number; inline?: string }[]> {
      const res = await app.request(`/api/packages/${packageId}/files`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { entries: { path: string; size: number; inline?: string }[] })
        .entries;
    }

    it("carries a forked integration's INTEGRATION.md through to the explorer", async () => {
      const srcCtx = await createTestContext({ orgSlug: "forkdoc" });
      const sourceId = "@forkdoc/documented";
      await publishIntegration(sourceId, srcCtx.orgId, {
        "INTEGRATION.md": new TextEncoder().encode(INTEGRATION_DOC),
      });

      const targetId = "@pkgorg/documented";
      await forkInto(sourceId, targetId);

      // The column the runtime reads (`fetchIntegrationPromptDocs`) — it was
      // `""`, so the fork silently stopped contributing its docs to every
      // agent's platform prompt.
      expect(await draftContentOf(targetId)).toBe(INTEGRATION_DOC);

      // …and what the explorer serves. The ZIP entry was always there; the
      // empty column was overlaid ON TOP of it, reporting `size: 0`.
      const doc = (await fileIndex(targetId)).find((f) => f.path === "INTEGRATION.md");
      expect(doc).toBeDefined();
      expect(doc!.inline).toBe(INTEGRATION_DOC);
      expect(doc!.size).toBe(new TextEncoder().encode(INTEGRATION_DOC).byteLength);
    });

    it('stores the manifest text — not `""` — when the source ships no doc', async () => {
      const srcCtx = await createTestContext({ orgSlug: "forknodoc" });
      const sourceId = "@forknodoc/bare";
      await publishIntegration(sourceId, srcCtx.orgId, {});

      const targetId = "@pkgorg/bare";
      await forkInto(sourceId, targetId);

      // What an import of the FORK's own bytes would have stored: for an
      // integration with no INTEGRATION.md, `parsePackageZip` falls back to the
      // manifest text. So the column must equal the fork's own `manifest.json`
      // — the renamed manifest, not the source's.
      const zip = await downloadVersionZip(targetId, "0.1.0");
      const artifactManifest = new TextDecoder().decode(
        unzipPackageArchive(zip!)["manifest.json"]!,
      );
      expect(await draftContentOf(targetId)).toBe(artifactManifest);
      expect(JSON.parse(artifactManifest)).toMatchObject({ name: targetId });

      // And the explorer invents no companion: a manifest-text column is a
      // fallback, never materialized as a phantom `INTEGRATION.md`.
      expect((await fileIndex(targetId)).map((f) => f.path)).not.toContain("INTEGRATION.md");
    });

    it("still reads an agent's prompt.md — the required entries are unchanged", async () => {
      const srcCtx = await createTestContext({ orgSlug: "forkprompt" });
      const sourceId = "@forkprompt/agent";
      const manifest = {
        name: sourceId,
        version: "0.1.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "Prompted",
        description: "Its prompt must survive the fork",
      };
      await seedPackage({
        id: sourceId,
        orgId: srcCtx.orgId,
        type: "agent",
        draftManifest: manifest,
        draftContent: "You are the source agent.",
      });
      const zip = buildMinimalZip(manifest, "You are the source agent.", "prompt.md");
      await uploadPackageZip(sourceId, "0.1.0", zip);
      const row = await seedPackageVersion({
        packageId: sourceId,
        version: "0.1.0",
        manifest,
        integrity: computeIntegrity(new Uint8Array(zip)),
        artifactSize: zip.byteLength,
      });
      await db
        .insert(packageDistTags)
        .values({ packageId: sourceId, tag: "latest", versionId: row.id });

      const res = await app.request(`/api/packages/${sourceId}/fork`, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);

      // NOT the manifest text: a required entry has no fallback in the parser
      // either, and storing one here would make the overlay materialize
      // manifest JSON AS the agent's prompt.
      expect(await draftContentOf("@pkgorg/agent")).toBe("You are the source agent.");
    });
  });

  // ═══════════════════════════════════════════════
  // POST fork — the SOURCE artifact is READ here, so the decompression ceiling
  // applies to this route too. A fork mints a new immutable artifact out of
  // bytes the caller does not own, so expanding a high-ratio source would both
  // amplify it and regrave it under the caller's own scope.
  // ═══════════════════════════════════════════════

  describe("POST fork — source artifact decompression ceiling", () => {
    it("422s on a source that expands past the ceiling, and mints nothing", async () => {
      const srcCtx = await createTestContext({ orgSlug: "forkbomb" });
      const sourceId = "@forkbomb/high-ratio-agent";
      const manifest = {
        name: sourceId,
        version: "0.1.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "High Ratio",
        description: "Published source whose artifact over-expands",
      };
      await seedPackage({
        id: sourceId,
        orgId: srcCtx.orgId,
        type: "agent",
        draftManifest: manifest,
        draftContent: "source prompt",
      });

      // Nine padding entries sharing ONE 6 MB buffer: 54 MB expanded, past the
      // 50 MB ceiling, for a few tens of KB on the wire and one allocation here.
      const block = new Uint8Array(6 * 1024 * 1024);
      const entries: Record<string, Uint8Array> = {
        "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
        "prompt.md": new TextEncoder().encode("source prompt"),
      };
      for (let i = 0; i < 9; i++) entries[`pad-${i}.bin`] = block;
      const zip = Buffer.from(zipArtifact(entries, 9));
      expect(zip.byteLength).toBeLessThan(PACKAGE_ZIP_MAX_COMPRESSED_BYTES);

      await uploadPackageZip(sourceId, "0.1.0", zip);
      const row = await seedPackageVersion({
        packageId: sourceId,
        version: "0.1.0",
        manifest,
        integrity: computeIntegrity(new Uint8Array(zip)),
        artifactSize: zip.byteLength,
      });
      await db
        .insert(packageDistTags)
        .values({ packageId: sourceId, tag: "latest", versionId: row.id });

      const res = await app.request(`/api/packages/${sourceId}/fork`, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({}),
      });

      // A typed 422, NOT the opaque `500 internal_error` an unmapped throw
      // would produce: the fork route has no try/catch, so the status is
      // decided entirely by the error being an ApiError.
      expect(res.status).toBe(422);
      expect(res.headers.get("Content-Type")).toContain("application/problem+json");
      expect(((await res.json()) as { code: string }).code).toBe("package_archive_unreadable");

      // The refusal lands while READING the source — before the collision check
      // and before any insert — so there is no half-made fork to clean up.
      await assertDbMissing(packages, eq(packages.id, "@pkgorg/high-ratio-agent"));
    });
  });
});
