// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun, seedConnectionProfile } from "../../helpers/seed.ts";
import { assertDbCount } from "../../helpers/assertions.ts";
import { runs } from "@appstrate/db/schema";

const app = getTestApp();

describe("Agents API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
  });

  describe("GET /api/agents", () => {
    it("returns empty list when no agents exist", async () => {
      const res = await app.request("/api/agents", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.agents).toBeArray();
      expect(body.agents).toHaveLength(0);
    });

    it("returns agents owned by the org", async () => {
      await seedAgent({ id: "@myorg/test-agent", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/agents", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.agents.length).toBeGreaterThanOrEqual(1);
      const agent = body.agents.find((f: { id: string }) => f.id === "@myorg/test-agent");
      expect(agent).toBeDefined();
      expect(agent.source).toBe("local");
    });

    it("does not leak agents from other orgs", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      await seedAgent({ id: "@otherorg/secret-agent", orgId: otherCtx.orgId });

      const res = await app.request("/api/agents", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const leaked = body.agents.find((f: { id: string }) => f.id === "@otherorg/secret-agent");
      expect(leaked).toBeUndefined();
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/agents");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/packages/agents/:scope/:name (agent detail)", () => {
    it("returns agent detail", async () => {
      await seedAgent({ id: "@myorg/detail-agent", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/packages/agents/@myorg/detail-agent", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.agent).toBeDefined();
      expect(body.agent.id).toBe("@myorg/detail-agent");
    });

    it("returns 404 for non-existent agent", async () => {
      const res = await app.request("/api/packages/agents/@myorg/nonexistent", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      });

      expect(res.status).toBe(404);
    });

    it("returns 404 for agent from another org", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg2" });
      await seedAgent({ id: "@otherorg2/private-agent", orgId: otherCtx.orgId });

      const res = await app.request("/api/packages/agents/@otherorg2/private-agent", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      });

      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/agents/:scope/:name/config", () => {
    it("updates agent configuration", async () => {
      await seedAgent({
        id: "@myorg/config-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@myorg/config-agent",
          version: "0.1.0",
          type: "agent",
          description: "Test",
          config: {
            schema: { type: "object", properties: { key: { type: "string" } } },
          },
        },
      });

      const res = await app.request("/api/agents/@myorg/config-agent/config", {
        method: "PUT",
        headers: {
          Cookie: ctx.cookie,
          "X-Org-Id": ctx.orgId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ key: "value" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.config.key).toBe("value");
      expect(body.validation.valid).toBe(true);
    });
  });

  describe("Multi-tenancy isolation", () => {
    it("isolates run counts per org", async () => {
      await seedAgent({ id: "@myorg/counted-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      await seedRun({
        packageId: "@myorg/counted-agent",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "success",
      });
      await seedRun({
        packageId: "@myorg/counted-agent",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "running",
      });

      // Verify DB state directly
      await assertDbCount(
        runs,
        and(eq(runs.packageId, "@myorg/counted-agent"), eq(runs.orgId, ctx.orgId))!,
        2,
      );

      // Verify running count in agent list
      const res = await app.request("/api/agents", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const agent = body.agents.find((f: { id: string }) => f.id === "@myorg/counted-agent");
      expect(agent).toBeDefined();
      expect(agent.runningRuns).toBe(1);
    });
  });

  // ─── Provider Profiles Routes ──────────────────────────────

  describe("GET /api/agents/:scope/:name/provider-profiles", () => {
    it("returns 200 with empty overrides initially", async () => {
      await seedAgent({ id: "@myorg/pp-agent", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/agents/@myorg/pp-agent/provider-profiles", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.overrides).toEqual({});
    });

    it("returns 401 without auth", async () => {
      await seedAgent({ id: "@myorg/pp-agent-noauth", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/agents/@myorg/pp-agent-noauth/provider-profiles");
      expect(res.status).toBe(401);
    });

    it("returns overrides after setting one", async () => {
      await seedAgent({ id: "@myorg/pp-agent-set", orgId: ctx.orgId, createdBy: ctx.user.id });
      const profile = await seedConnectionProfile({ userId: ctx.user.id, name: "Alt" });

      await app.request("/api/agents/@myorg/pp-agent-set/provider-profiles", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "@system/gmail", profileId: profile.id }),
      });

      const res = await app.request("/api/agents/@myorg/pp-agent-set/provider-profiles", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.overrides["@system/gmail"]).toBe(profile.id);
    });
  });

  describe("PUT /api/agents/:scope/:name/provider-profiles", () => {
    it("returns 200 on valid body", async () => {
      await seedAgent({ id: "@myorg/pp-put", orgId: ctx.orgId, createdBy: ctx.user.id });
      const profile = await seedConnectionProfile({ userId: ctx.user.id, name: "P" });

      const res = await app.request("/api/agents/@myorg/pp-put/provider-profiles", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "@system/gmail", profileId: profile.id }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
    });

    it("returns 400 with invalid profileId", async () => {
      await seedAgent({ id: "@myorg/pp-put-bad", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/agents/@myorg/pp-put-bad/provider-profiles", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "@system/gmail", profileId: "not-a-uuid" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 with missing providerId", async () => {
      await seedAgent({ id: "@myorg/pp-put-noprov", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/agents/@myorg/pp-put-noprov/provider-profiles", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: "00000000-0000-0000-0000-000000000000" }),
      });
      expect(res.status).toBe(400);
    });

    it("accepts an org profile for provider override", async () => {
      await seedAgent({ id: "@myorg/pp-put-org", orgId: ctx.orgId, createdBy: ctx.user.id });
      const orgProfile = await seedConnectionProfile({ orgId: ctx.orgId, name: "Org" });

      const res = await app.request("/api/agents/@myorg/pp-put-org/provider-profiles", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "@system/gmail", profileId: orgProfile.id }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("DELETE /api/agents/:scope/:name/provider-profiles", () => {
    it("removes an override and returns success", async () => {
      await seedAgent({ id: "@myorg/pp-del", orgId: ctx.orgId, createdBy: ctx.user.id });
      const profile = await seedConnectionProfile({ userId: ctx.user.id, name: "D" });

      // Set then remove
      await app.request("/api/agents/@myorg/pp-del/provider-profiles", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "@system/gmail", profileId: profile.id }),
      });

      const res = await app.request("/api/agents/@myorg/pp-del/provider-profiles", {
        method: "DELETE",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "@system/gmail" }),
      });
      expect(res.status).toBe(200);

      // Verify removed
      const listRes = await app.request("/api/agents/@myorg/pp-del/provider-profiles", {
        headers: authHeaders(ctx),
      });
      const listBody = (await listRes.json()) as any;
      expect(listBody.overrides["@system/gmail"]).toBeUndefined();
    });

    it("returns 400 with missing providerId", async () => {
      await seedAgent({ id: "@myorg/pp-del-bad", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/agents/@myorg/pp-del-bad/provider-profiles", {
        method: "DELETE",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── Org Profile on Agent ─────────────────────────────────

  describe("PUT /api/agents/:scope/:name/org-profile", () => {
    it("admin can set org profile on an agent", async () => {
      await seedAgent({ id: "@myorg/orgp-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const orgProfile = await seedConnectionProfile({ orgId: ctx.orgId, name: "Org Prof" });

      const res = await app.request("/api/agents/@myorg/orgp-agent/org-profile", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ orgProfileId: orgProfile.id }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
    });

    it("admin can unset org profile with null", async () => {
      await seedAgent({ id: "@myorg/orgp-unset", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/agents/@myorg/orgp-unset/org-profile", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ orgProfileId: null }),
      });

      expect(res.status).toBe(200);
    });

    it("returns 400 with invalid orgProfileId", async () => {
      await seedAgent({ id: "@myorg/orgp-bad", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/agents/@myorg/orgp-bad/org-profile", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ orgProfileId: "not-a-uuid" }),
      });

      expect(res.status).toBe(400);
    });
  });

  // ─── Agent Detail — Org Profile Fields ─────────────────────

  describe("agent detail — org profile fields", () => {
    it("returns agentOrgProfileId and agentOrgProfileName when set", async () => {
      await seedAgent({ id: "@myorg/detail-orgp", orgId: ctx.orgId, createdBy: ctx.user.id });
      const orgProfile = await seedConnectionProfile({ orgId: ctx.orgId, name: "Prod Creds" });

      await app.request("/api/agents/@myorg/detail-orgp/org-profile", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ orgProfileId: orgProfile.id }),
      });

      const res = await app.request("/api/packages/agents/@myorg/detail-orgp", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.agent.agentOrgProfileId).toBe(orgProfile.id);
      expect(body.agent.agentOrgProfileName).toBe("Prod Creds");
    });

    it("returns null agentOrgProfileId when no org profile configured", async () => {
      await seedAgent({ id: "@myorg/detail-nop", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/packages/agents/@myorg/detail-nop", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.agent.agentOrgProfileId).toBeNull();
      expect(body.agent.agentOrgProfileName).toBeNull();
    });

    it("returns null agentOrgProfileId when configured profile was deleted", async () => {
      await seedAgent({ id: "@myorg/detail-del", orgId: ctx.orgId, createdBy: ctx.user.id });
      const orgProfile = await seedConnectionProfile({ orgId: ctx.orgId, name: "Temp" });

      // Set then delete the profile
      await app.request("/api/agents/@myorg/detail-del/org-profile", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ orgProfileId: orgProfile.id }),
      });
      await app.request(`/api/connection-profiles/org/${orgProfile.id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      const res = await app.request("/api/packages/agents/@myorg/detail-del", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.agent.agentOrgProfileId).toBeNull();
      expect(body.agent.agentOrgProfileName).toBeNull();
    });
  });
});
