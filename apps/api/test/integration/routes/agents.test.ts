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
import { addMemories, upsertPinned } from "../../../src/services/state/package-persistence.ts";

const app = getTestApp();

/** Seed an agent and install it in the default app. */
async function seedInstalledAgent(overrides: Parameters<typeof seedAgent>[0] & { appId: string }) {
  const { appId, ...rest } = overrides;
  const pkg = await seedAgent(rest);
  await installPackage({ orgId: rest.orgId!, applicationId: appId }, pkg.id);
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
      expect(body.data).toBeArray();
      expect(body.data).toHaveLength(0);
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
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      const agent = body.data.find((f: { id: string }) => f.id === "@myorg/test-agent");
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
      const leaked = body.data.find((f: { id: string }) => f.id === "@otherorg/secret-agent");
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
      await installPackage(
        { orgId: ctx.orgId, applicationId: customApp.id },
        "@myorg/custom-installed",
      );

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
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@myorg/config-agent",
      );

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

  describe("GET /api/agents/:scope/:name/bundle — 404 distinction", () => {
    // The bundle route deliberately distinguishes "agent doesn't exist in
    // this org" from "agent exists in org but isn't installed in the
    // pinned application" — the CLI's run-by-id flow needs to tell the
    // user whether to fix the spelling or run an install. Pin both
    // branches so the contract holds across refactors.

    it("returns 404 agent_not_found when the package isn't in the org catalog", async () => {
      const res = await app.request("/api/agents/@myorg/does-not-exist/bundle", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code?: string; detail?: string };
      expect(body.code).toBe("agent_not_found");
    });

    it("returns 404 agent_not_installed_in_app when the package exists in org but is not installed in the pinned app", async () => {
      // Seed the agent at the org level, but DON'T install it into the app.
      await seedAgent({
        id: "@myorg/uninstalled-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/agents/@myorg/uninstalled-agent/bundle", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code?: string; detail?: string };
      expect(body.code).toBe("agent_not_installed_in_app");
      // The detail names the application and the install endpoint so the
      // CLI's hint can quote it back to the user verbatim.
      expect(body.detail).toContain(ctx.defaultAppId);
      expect(body.detail).toContain("/api/applications/");
    });

    it("passes the access gate when the package is installed (subsequent failures are version/artifact, not access)", async () => {
      // The 200/version-resolution path requires a published artifact in
      // storage that the seed helpers don't set up. The relevant contract
      // for *this* gate is that we don't surface `agent_not_installed_in_app`
      // for an installed package — version-resolution failures throw
      // `not_found`, a different code.
      await seedInstalledAgent({
        id: "@myorg/installed-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });

      const res = await app.request("/api/agents/@myorg/installed-agent/bundle", {
        headers: authHeaders(ctx),
      });
      const body = (await res.json()) as { code?: string };
      expect(body.code).not.toBe("agent_not_installed_in_app");
      expect(body.code).not.toBe("agent_not_found");
    });
  });

  describe("GET /api/agents/:scope/:name/bundle?source=draft — UI parity path", () => {
    // Pin the dashboard-Run-button parity contract. A never-published
    // agent must bundle its draft state via `?source=draft`, otherwise
    // `appstrate run @scope/agent` fails with `no_published_version`
    // on agents the dashboard runs happily.

    it("returns 200 + a deterministic .afps-bundle for an installed never-published agent", async () => {
      await seedInstalledAgent({
        id: "@myorg/draft-only",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });

      const res = await app.request("/api/agents/@myorg/draft-only/bundle?source=draft", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const integrity = res.headers.get("X-Bundle-Integrity");
      expect(integrity).toMatch(/^sha256-/);
      expect(res.headers.get("Content-Type")).toBe("application/zip");

      // X-Bundle-Integrity contract: SHA256 over the wire bytes, NOT the
      // in-archive `bundle.integrity` field (which is the canonical
      // packages-map JSON SRI). The CLI recomputes the wire digest after
      // download to detect proxy/CDN corruption — a regression that ever
      // sends `bundle.integrity` instead trips `integrity_mismatch` on
      // every clean run, which is the exact bug we just fixed.
      const body = new Uint8Array(await res.arrayBuffer());
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(body);
      const computed = `sha256-${hasher.digest("base64")}`;
      expect(integrity).toBe(computed);
    });

    it("rejects ?source=draft combined with ?version= (400 draft_with_version)", async () => {
      await seedInstalledAgent({
        id: "@myorg/draft-with-version",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });

      const res = await app.request(
        "/api/agents/@myorg/draft-with-version/bundle?source=draft&version=1.0.0",
        { headers: authHeaders(ctx) },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("draft_with_version");
    });

    it("rejects ?source=foo (400 invalid_source)", async () => {
      const res = await app.request("/api/agents/@myorg/anything/bundle?source=experimental", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("invalid_source");
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
        userId: ctx.user.id,
        status: "success",
      });
      await seedRun({
        packageId: "@myorg/counted-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
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
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const agent = body.data.find((f: { id: string }) => f.id === "@myorg/counted-agent");
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

  // ─── Persistence Routes (ADR-011 + ADR-013 — pinned slots + memories) ─

  describe("GET /api/agents/:scope/:name/persistence", () => {
    it("returns pinned slots as an array (admin sees every actor's row)", async () => {
      await seedInstalledAgent({
        id: "@myorg/persist-list",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });

      // Two distinct scopes write pinned `checkpoint` slots
      await upsertPinned(
        "@myorg/persist-list",
        ctx.defaultAppId,
        ctx.orgId,
        { type: "user", id: ctx.user.id },
        "checkpoint",
        { step: "user-checkpoint" },
        null,
      );
      await upsertPinned(
        "@myorg/persist-list",
        ctx.defaultAppId,
        ctx.orgId,
        { type: "shared" },
        "checkpoint",
        { step: "shared-checkpoint" },
        null,
      );

      const res = await app.request("/api/agents/@myorg/persist-list/persistence?kind=pinned", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        pinned: Array<{ key: string; actorType: string; content: { step: string } }>;
      };
      expect(Array.isArray(body.pinned)).toBe(true);
      expect(body.pinned).toHaveLength(2);
      const actorTypes = body.pinned.map((c) => c.actorType).sort();
      expect(actorTypes).toEqual(["shared", "user"]);
      // Every row is the `checkpoint` slot here.
      expect(body.pinned.every((c) => c.key === "checkpoint")).toBe(true);
    });

    it("returns Letta-style named pinned slots alongside the checkpoint slot", async () => {
      await seedInstalledAgent({
        id: "@myorg/persist-named-pin",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });

      // Mix of keys: `checkpoint` + Letta-style `persona` + `goals`
      await upsertPinned(
        "@myorg/persist-named-pin",
        ctx.defaultAppId,
        ctx.orgId,
        { type: "shared" },
        "checkpoint",
        { step: "carry-over" },
        null,
      );
      await upsertPinned(
        "@myorg/persist-named-pin",
        ctx.defaultAppId,
        ctx.orgId,
        { type: "shared" },
        "persona",
        "Senior coding assistant",
        null,
      );
      await upsertPinned(
        "@myorg/persist-named-pin",
        ctx.defaultAppId,
        ctx.orgId,
        { type: "shared" },
        "goals",
        ["ship faster", "fewer bugs"],
        null,
      );

      const res = await app.request(
        "/api/agents/@myorg/persist-named-pin/persistence?kind=pinned",
        { headers: authHeaders(ctx) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        pinned: Array<{ key: string; content: unknown }>;
      };
      const keys = body.pinned.map((p) => p.key).sort();
      expect(keys).toEqual(["checkpoint", "goals", "persona"]);
    });

    it("filters memories by runId", async () => {
      await seedInstalledAgent({
        id: "@myorg/persist-runid",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });
      const r1 = await seedRun({
        packageId: "@myorg/persist-runid",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });
      const r2 = await seedRun({
        packageId: "@myorg/persist-runid",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });
      await addMemories(
        "@myorg/persist-runid",
        ctx.defaultAppId,
        ctx.orgId,
        { type: "user", id: ctx.user.id },
        ["from-r1-a", "from-r1-b"],
        r1.id,
      );
      await addMemories(
        "@myorg/persist-runid",
        ctx.defaultAppId,
        ctx.orgId,
        { type: "user", id: ctx.user.id },
        ["from-r2"],
        r2.id,
      );

      const res = await app.request(
        `/api/agents/@myorg/persist-runid/persistence?kind=memory&runId=${r1.id}`,
        { headers: authHeaders(ctx) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { memories: Array<{ runId: string }> };
      expect(body.memories).toHaveLength(2);
      expect(body.memories.every((m) => m.runId === r1.id)).toBe(true);
    });
  });

  describe("DELETE /api/agents/:scope/:name/persistence/pinned/:id", () => {
    it("deletes a single pinned slot by id", async () => {
      await seedInstalledAgent({
        id: "@myorg/persist-del-cp",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });
      await upsertPinned(
        "@myorg/persist-del-cp",
        ctx.defaultAppId,
        ctx.orgId,
        { type: "shared" },
        "checkpoint",
        { step: "x" },
        null,
      );

      const listRes = await app.request(
        "/api/agents/@myorg/persist-del-cp/persistence?kind=pinned",
        { headers: authHeaders(ctx) },
      );
      const listBody = (await listRes.json()) as { pinned: Array<{ id: number }> };
      expect(listBody.pinned).toHaveLength(1);
      const slotId = listBody.pinned[0]!.id;

      const delRes = await app.request(
        `/api/agents/@myorg/persist-del-cp/persistence/pinned/${slotId}`,
        { method: "DELETE", headers: authHeaders(ctx) },
      );
      expect(delRes.status).toBe(200);

      const after = await app.request("/api/agents/@myorg/persist-del-cp/persistence?kind=pinned", {
        headers: authHeaders(ctx),
      });
      const afterBody = (await after.json()) as { pinned: unknown[] };
      expect(afterBody.pinned).toHaveLength(0);
    });

    it("deletes a Letta-style named pinned slot (e.g. persona) by id", async () => {
      await seedInstalledAgent({
        id: "@myorg/persist-del-persona",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });
      await upsertPinned(
        "@myorg/persist-del-persona",
        ctx.defaultAppId,
        ctx.orgId,
        { type: "shared" },
        "persona",
        "Senior coding assistant",
        null,
      );

      const listRes = await app.request(
        "/api/agents/@myorg/persist-del-persona/persistence?kind=pinned",
        { headers: authHeaders(ctx) },
      );
      const listBody = (await listRes.json()) as { pinned: Array<{ id: number; key: string }> };
      const personaSlot = listBody.pinned.find((s) => s.key === "persona")!;

      const delRes = await app.request(
        `/api/agents/@myorg/persist-del-persona/persistence/pinned/${personaSlot.id}`,
        { method: "DELETE", headers: authHeaders(ctx) },
      );
      expect(delRes.status).toBe(200);
    });

    it("returns 404 for unknown pinned slot id", async () => {
      await seedInstalledAgent({
        id: "@myorg/persist-del-404",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        appId: ctx.defaultAppId,
      });

      const res = await app.request(
        "/api/agents/@myorg/persist-del-404/persistence/pinned/999999",
        { method: "DELETE", headers: authHeaders(ctx) },
      );
      expect(res.status).toBe(404);
    });
  });
});
