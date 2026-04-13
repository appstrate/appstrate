// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun, seedConnectionProfile, seedApplication } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { assertDbCount } from "../../helpers/assertions.ts";
import { runs } from "@appstrate/db/schema";

const app = getTestApp();

/** Seed an agent and install it in the default app. */
async function seedInstalledAgent(overrides: Parameters<typeof seedAgent>[0] & { appId: string }) {
  const { appId, ...rest } = overrides;
  const pkg = await seedAgent(rest);
  await installPackage(appId, rest.orgId!, pkg.id);
  return pkg;
}

describe("Agents API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
  });

  describe("GET /api/agents", () => {
    it("returns empty list when no agents exist", async () => {
      const res = await app.request("/api/agents", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.agents).toBeArray();
      expect(body.agents).toHaveLength(0);
    });

    it("returns agents installed in the current app", async () => {
      await seedInstalledAgent({
        id: "@myorg/test-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });

      const res = await app.request("/api/agents", {
        headers: authHeaders(ctx),
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
        headers: authHeaders(ctx),
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
    it("returns agent detail when installed", async () => {
      await seedInstalledAgent({
        id: "@myorg/detail-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });

      const res = await app.request("/api/packages/agents/@myorg/detail-agent", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.agent).toBeDefined();
      expect(body.agent.id).toBe("@myorg/detail-agent");
    });

    it("returns 404 for non-existent agent", async () => {
      const res = await app.request("/api/packages/agents/@myorg/nonexistent", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 404 for agent from another org", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg2" });
      await seedAgent({ id: "@otherorg2/private-agent", orgId: otherCtx.orgId });

      const res = await app.request("/api/packages/agents/@otherorg2/private-agent", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 404 from default app when agent is not installed (no bypass)", async () => {
      await seedAgent({ id: "@myorg/default-hidden", orgId: ctx.orgId, createdBy: ctx.user.id });

      // Agent is in the org catalog but NOT installed in the default app
      const res = await app.request("/api/packages/agents/@myorg/default-hidden", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 200 from default app when agent is installed", async () => {
      await seedInstalledAgent({
        id: "@myorg/default-installed",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });

      const res = await app.request("/api/packages/agents/@myorg/default-installed", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.agent.id).toBe("@myorg/default-installed");
    });

    it("returns 404 from custom app when agent is not installed", async () => {
      await seedAgent({ id: "@myorg/custom-hidden", orgId: ctx.orgId, createdBy: ctx.user.id });

      const customApp = await seedApplication({
        orgId: ctx.orgId,
        name: "Custom App",
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/agents/@myorg/custom-hidden", {
        headers: { ...authHeaders(ctx), "X-App-Id": customApp.id },
      });

      expect(res.status).toBe(404);
    });

    it("returns 200 from custom app when agent is installed", async () => {
      await seedAgent({ id: "@myorg/custom-installed", orgId: ctx.orgId, createdBy: ctx.user.id });

      const customApp = await seedApplication({
        orgId: ctx.orgId,
        name: "Custom Installed",
        createdBy: ctx.user.id,
      });
      await installPackage(customApp.id, ctx.orgId, "@myorg/custom-installed");

      const res = await app.request("/api/packages/agents/@myorg/custom-installed", {
        headers: { ...authHeaders(ctx), "X-App-Id": customApp.id },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.agent.id).toBe("@myorg/custom-installed");
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
      await installPackage(ctx.defaultAppId, ctx.orgId, "@myorg/config-agent");

      const res = await app.request("/api/agents/@myorg/config-agent/config", {
        method: "PUT",
        headers: {
          ...authHeaders(ctx),
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
      await seedInstalledAgent({
        id: "@myorg/counted-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });
      await seedRun({
        packageId: "@myorg/counted-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
        status: "success",
      });
      await seedRun({
        packageId: "@myorg/counted-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
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
        headers: authHeaders(ctx),
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
      await seedInstalledAgent({
        id: "@myorg/pp-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });

      const res = await app.request("/api/agents/@myorg/pp-agent/provider-profiles", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.overrides).toEqual({});
    });

    it("returns 401 without auth", async () => {
      await seedInstalledAgent({
        id: "@myorg/pp-agent-noauth",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });

      const res = await app.request("/api/agents/@myorg/pp-agent-noauth/provider-profiles");
      expect(res.status).toBe(401);
    });

    it("returns overrides after setting one", async () => {
      await seedInstalledAgent({
        id: "@myorg/pp-agent-set",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });
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
      await seedInstalledAgent({
        id: "@myorg/pp-put",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });
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
      await seedInstalledAgent({
        id: "@myorg/pp-put-bad",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });

      const res = await app.request("/api/agents/@myorg/pp-put-bad/provider-profiles", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "@system/gmail", profileId: "not-a-uuid" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 with missing providerId", async () => {
      await seedInstalledAgent({
        id: "@myorg/pp-put-noprov",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });

      const res = await app.request("/api/agents/@myorg/pp-put-noprov/provider-profiles", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: "00000000-0000-0000-0000-000000000000" }),
      });
      expect(res.status).toBe(400);
    });

    it("accepts an app profile for provider override", async () => {
      await seedInstalledAgent({
        id: "@myorg/pp-put-app",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });
      const appProfile = await seedConnectionProfile({
        applicationId: ctx.defaultAppId,
        name: "App",
      });

      const res = await app.request("/api/agents/@myorg/pp-put-app/provider-profiles", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "@system/gmail", profileId: appProfile.id }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("DELETE /api/agents/:scope/:name/provider-profiles", () => {
    it("removes an override and returns success", async () => {
      await seedInstalledAgent({
        id: "@myorg/pp-del",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });
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
      await seedInstalledAgent({
        id: "@myorg/pp-del-bad",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });

      const res = await app.request("/api/agents/@myorg/pp-del-bad/provider-profiles", {
        method: "DELETE",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── App Profile on Agent ─────────────────────────────────

  describe("PUT /api/agents/:scope/:name/app-profile", () => {
    it("admin can set app profile on an agent", async () => {
      await seedInstalledAgent({
        id: "@myorg/appp-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });
      const appProfile = await seedConnectionProfile({
        applicationId: ctx.defaultAppId,
        name: "App Prof",
      });

      const res = await app.request("/api/agents/@myorg/appp-agent/app-profile", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ appProfileId: appProfile.id }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
    });

    it("admin can unset app profile with null", async () => {
      await seedInstalledAgent({
        id: "@myorg/appp-unset",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });

      const res = await app.request("/api/agents/@myorg/appp-unset/app-profile", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ appProfileId: null }),
      });

      expect(res.status).toBe(200);
    });

    it("returns 400 with invalid appProfileId", async () => {
      await seedInstalledAgent({
        id: "@myorg/appp-bad",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });

      const res = await app.request("/api/agents/@myorg/appp-bad/app-profile", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ appProfileId: "not-a-uuid" }),
      });

      expect(res.status).toBe(400);
    });
  });

  // ─── Agent Detail — App Profile Fields ─────────────────────

  describe("agent detail — app profile fields", () => {
    it("returns agentAppProfileId and agentAppProfileName when set", async () => {
      await seedInstalledAgent({
        id: "@myorg/detail-appp",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });
      const appProfile = await seedConnectionProfile({
        applicationId: ctx.defaultAppId,
        name: "Prod Creds",
      });

      await app.request("/api/agents/@myorg/detail-appp/app-profile", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ appProfileId: appProfile.id }),
      });

      const res = await app.request("/api/packages/agents/@myorg/detail-appp", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.agent.agentAppProfileId).toBe(appProfile.id);
      expect(body.agent.agentAppProfileName).toBe("Prod Creds");
    });

    it("returns null agentAppProfileId when no app profile configured", async () => {
      await seedInstalledAgent({
        id: "@myorg/detail-nop",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });

      const res = await app.request("/api/packages/agents/@myorg/detail-nop", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.agent.agentAppProfileId).toBeNull();
      expect(body.agent.agentAppProfileName).toBeNull();
    });

    it("returns null agentAppProfileId when configured profile was deleted", async () => {
      await seedInstalledAgent({
        id: "@myorg/detail-del",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });
      const appProfile = await seedConnectionProfile({
        applicationId: ctx.defaultAppId,
        name: "Temp",
      });

      // Set then delete the profile
      await app.request("/api/agents/@myorg/detail-del/app-profile", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ appProfileId: appProfile.id }),
      });
      await app.request(`/api/app-profiles/${appProfile.id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      const res = await app.request("/api/packages/agents/@myorg/detail-del", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.agent.agentAppProfileId).toBeNull();
      expect(body.agent.agentAppProfileName).toBeNull();
    });
  });
});
