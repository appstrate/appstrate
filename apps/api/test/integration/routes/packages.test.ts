// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedPackage, seedPackageVersion, seedApplication } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
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
            schema_version: "2.0",
            display_name: "New Agent",
            description: "A brand new agent",
          },
          content: "You are a helpful assistant.",
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.packageId).toBe("@pkgorg/new-agent");
      expect(body.lock_version).toBeNumber();

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
            schema_version: "2.0",
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
            schema_version: "2.0",
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
            schema_version: "2.0",
            display_name: "Unauth Agent",
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
            schema_version: "2.0",
            display_name: "Mismatched Agent",
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
            schema_version: "2.0",
            display_name: "Update Agent",
            description: "Updated agent",
          },
          content: "Updated prompt content.",
          lock_version: agent.lockVersion,
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.packageId).toBe("@pkgorg/update-agent");
      expect(body.lock_version).toBeGreaterThan(agent.lockVersion!);
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
            schema_version: "2.0",
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
            schema_version: "2.0",
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
            schema_version: "2.0",
            display_name: "Hijack Agent",
            description: "Hijack",
          },
          content: "hijack",
          lock_version: 1,
        }),
      });

      expect(res.status).toBe(403);
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
          schema_version: "2.0",
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
            list_messages: { required_scopes: ["read"] },
            send_message: { required_scopes: ["send"] },
          },
        },
      });
    }

    function buildAgentBody(
      selection: { version: string; tools?: string[]; scopes?: string[] } | string,
      suffix = "ok",
    ) {
      const isBare = typeof selection === "string";
      const manifest: Record<string, unknown> = {
        name: `@pkgorg/agent-${suffix}`,
        version: "0.1.0",
        type: "agent",
        schema_version: "2.0",
        display_name: `Agent ${suffix}`,
        dependencies: {
          integrations: { [integrationId]: isBare ? selection : selection.version },
        },
      };
      if (!isBare && (selection.tools !== undefined || selection.scopes !== undefined)) {
        manifest.integrations = {
          [integrationId]: {
            ...(selection.tools !== undefined ? { tools: selection.tools } : {}),
            ...(selection.scopes !== undefined ? { scopes: selection.scopes } : {}),
          },
        };
      }
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
      expect(body.errors?.[0]?.field).toBe(`integrations.${integrationId}.tools`);
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
            schema_version: "2.0",
            display_name: "Updated",
            dependencies: { integrations: { [integrationId]: "^1.0.0" } },
            integrations: { [integrationId]: { tools: ["nope"] } },
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
});
