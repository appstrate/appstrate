import { describe, it, expect, beforeEach } from "bun:test";
import { eq, and } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  addOrgMember,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedFlow, seedExecution, seedConnectionProfile } from "../../helpers/seed.ts";
import { assertDbCount } from "../../helpers/assertions.ts";
import { executions } from "@appstrate/db/schema";

const app = getTestApp();

describe("Flows API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
  });

  describe("GET /api/flows", () => {
    it("returns empty list when no flows exist", async () => {
      const res = await app.request("/api/flows", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.flows).toBeArray();
      expect(body.flows).toHaveLength(0);
    });

    it("returns flows owned by the org", async () => {
      await seedFlow({ id: "@myorg/test-flow", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/flows", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.flows.length).toBeGreaterThanOrEqual(1);
      const flow = body.flows.find((f: { id: string }) => f.id === "@myorg/test-flow");
      expect(flow).toBeDefined();
      expect(flow.source).toBe("local");
    });

    it("does not leak flows from other orgs", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      await seedFlow({ id: "@otherorg/secret-flow", orgId: otherCtx.orgId });

      const res = await app.request("/api/flows", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      const leaked = body.flows.find((f: { id: string }) => f.id === "@otherorg/secret-flow");
      expect(leaked).toBeUndefined();
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/flows");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/packages/flows/:scope/:name (flow detail)", () => {
    it("returns flow detail", async () => {
      await seedFlow({ id: "@myorg/detail-flow", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/packages/flows/@myorg/detail-flow", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.flow).toBeDefined();
      expect(body.flow.id).toBe("@myorg/detail-flow");
    });

    it("returns 404 for non-existent flow", async () => {
      const res = await app.request("/api/packages/flows/@myorg/nonexistent", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      });

      expect(res.status).toBe(404);
    });

    it("returns 404 for flow from another org", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg2" });
      await seedFlow({ id: "@otherorg2/private-flow", orgId: otherCtx.orgId });

      const res = await app.request("/api/packages/flows/@otherorg2/private-flow", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      });

      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/flows/:scope/:name/config", () => {
    it("updates flow configuration", async () => {
      await seedFlow({
        id: "@myorg/config-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@myorg/config-flow",
          version: "0.1.0",
          type: "flow",
          description: "Test",
          config: {
            schema: { type: "object", properties: { key: { type: "string" } } },
          },
        },
      });

      const res = await app.request("/api/flows/@myorg/config-flow/config", {
        method: "PUT",
        headers: {
          Cookie: ctx.cookie,
          "X-Org-Id": ctx.orgId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ key: "value" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.config.key).toBe("value");
      expect(body.validation.valid).toBe(true);
    });
  });

  describe("Multi-tenancy isolation", () => {
    it("isolates execution counts per org", async () => {
      await seedFlow({ id: "@myorg/counted-flow", orgId: ctx.orgId, createdBy: ctx.user.id });
      await seedExecution({
        packageId: "@myorg/counted-flow",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "success",
      });
      await seedExecution({
        packageId: "@myorg/counted-flow",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "running",
      });

      // Verify DB state directly
      await assertDbCount(
        executions,
        and(eq(executions.packageId, "@myorg/counted-flow"), eq(executions.orgId, ctx.orgId))!,
        2,
      );

      // Verify running count in flow list
      const res = await app.request("/api/flows", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      const flow = body.flows.find((f: { id: string }) => f.id === "@myorg/counted-flow");
      expect(flow).toBeDefined();
      expect(flow.runningExecutions).toBe(1);
    });
  });

  // ─── Provider Profiles Routes ──────────────────────────────

  describe("GET /api/flows/:scope/:name/provider-profiles", () => {
    it("returns 200 with empty overrides initially", async () => {
      await seedFlow({ id: "@myorg/pp-flow", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/flows/@myorg/pp-flow/provider-profiles", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.overrides).toEqual({});
    });

    it("returns 401 without auth", async () => {
      await seedFlow({ id: "@myorg/pp-flow-noauth", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/flows/@myorg/pp-flow-noauth/provider-profiles");
      expect(res.status).toBe(401);
    });

    it("returns overrides after setting one", async () => {
      await seedFlow({ id: "@myorg/pp-flow-set", orgId: ctx.orgId, createdBy: ctx.user.id });
      const profile = await seedConnectionProfile({ userId: ctx.user.id, name: "Alt" });

      await app.request("/api/flows/@myorg/pp-flow-set/provider-profiles", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "@system/gmail", profileId: profile.id }),
      });

      const res = await app.request("/api/flows/@myorg/pp-flow-set/provider-profiles", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.overrides["@system/gmail"]).toBe(profile.id);
    });
  });

  describe("PUT /api/flows/:scope/:name/provider-profiles", () => {
    it("returns 200 on valid body", async () => {
      await seedFlow({ id: "@myorg/pp-put", orgId: ctx.orgId, createdBy: ctx.user.id });
      const profile = await seedConnectionProfile({ userId: ctx.user.id, name: "P" });

      const res = await app.request("/api/flows/@myorg/pp-put/provider-profiles", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "@system/gmail", profileId: profile.id }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
    });

    it("returns 400 with invalid profileId", async () => {
      await seedFlow({ id: "@myorg/pp-put-bad", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/flows/@myorg/pp-put-bad/provider-profiles", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "@system/gmail", profileId: "not-a-uuid" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 with missing providerId", async () => {
      await seedFlow({ id: "@myorg/pp-put-noprov", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/flows/@myorg/pp-put-noprov/provider-profiles", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: "00000000-0000-0000-0000-000000000000" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/flows/:scope/:name/provider-profiles", () => {
    it("removes an override and returns success", async () => {
      await seedFlow({ id: "@myorg/pp-del", orgId: ctx.orgId, createdBy: ctx.user.id });
      const profile = await seedConnectionProfile({ userId: ctx.user.id, name: "D" });

      // Set then remove
      await app.request("/api/flows/@myorg/pp-del/provider-profiles", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "@system/gmail", profileId: profile.id }),
      });

      const res = await app.request("/api/flows/@myorg/pp-del/provider-profiles", {
        method: "DELETE",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "@system/gmail" }),
      });
      expect(res.status).toBe(200);

      // Verify removed
      const listRes = await app.request("/api/flows/@myorg/pp-del/provider-profiles", {
        headers: authHeaders(ctx),
      });
      const listBody = (await listRes.json()) as any;
      expect(listBody.overrides["@system/gmail"]).toBeUndefined();
    });

    it("returns 400 with missing providerId", async () => {
      await seedFlow({ id: "@myorg/pp-del-bad", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/flows/@myorg/pp-del-bad/provider-profiles", {
        method: "DELETE",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── Org Profile on Flow ──────────────────────────────────

  describe("PUT /api/flows/:scope/:name/org-profile", () => {
    it("admin can set org profile on a flow", async () => {
      await seedFlow({ id: "@myorg/orgp-flow", orgId: ctx.orgId, createdBy: ctx.user.id });
      const orgProfile = await seedConnectionProfile({ orgId: ctx.orgId, name: "Org Prof" });

      const res = await app.request("/api/flows/@myorg/orgp-flow/org-profile", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ orgProfileId: orgProfile.id }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
    });

    it("admin can unset org profile with null", async () => {
      await seedFlow({ id: "@myorg/orgp-unset", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/flows/@myorg/orgp-unset/org-profile", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ orgProfileId: null }),
      });

      expect(res.status).toBe(200);
    });

    it("returns 403 for non-admin member", async () => {
      await seedFlow({ id: "@myorg/orgp-forbid", orgId: ctx.orgId, createdBy: ctx.user.id });
      const member = await createTestUser();
      await addOrgMember(ctx.orgId, member.id, "member");
      const memberCtx: TestContext = {
        user: { id: member.id, email: member.email, name: member.name },
        org: ctx.org,
        cookie: member.cookie,
        orgId: ctx.orgId,
        defaultAppId: ctx.defaultAppId,
      };

      const res = await app.request("/api/flows/@myorg/orgp-forbid/org-profile", {
        method: "PUT",
        headers: { ...authHeaders(memberCtx), "Content-Type": "application/json" },
        body: JSON.stringify({ orgProfileId: null }),
      });

      expect(res.status).toBe(403);
    });

    it("returns 400 with invalid orgProfileId", async () => {
      await seedFlow({ id: "@myorg/orgp-bad", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/flows/@myorg/orgp-bad/org-profile", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ orgProfileId: "not-a-uuid" }),
      });

      expect(res.status).toBe(400);
    });
  });

  // ─── Flow Detail — Org Profile Fields ──────────────────────

  describe("flow detail — org profile fields", () => {
    it("returns flowOrgProfileId and flowOrgProfileName when set", async () => {
      await seedFlow({ id: "@myorg/detail-orgp", orgId: ctx.orgId, createdBy: ctx.user.id });
      const orgProfile = await seedConnectionProfile({ orgId: ctx.orgId, name: "Prod Creds" });

      await app.request("/api/flows/@myorg/detail-orgp/org-profile", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ orgProfileId: orgProfile.id }),
      });

      const res = await app.request("/api/packages/flows/@myorg/detail-orgp", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.flow.flowOrgProfileId).toBe(orgProfile.id);
      expect(body.flow.flowOrgProfileName).toBe("Prod Creds");
    });

    it("returns null flowOrgProfileId when no org profile configured", async () => {
      await seedFlow({ id: "@myorg/detail-nop", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/packages/flows/@myorg/detail-nop", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.flow.flowOrgProfileId).toBeNull();
      expect(body.flow.flowOrgProfileName).toBeNull();
    });

    it("returns null flowOrgProfileId when configured profile was deleted", async () => {
      await seedFlow({ id: "@myorg/detail-del", orgId: ctx.orgId, createdBy: ctx.user.id });
      const orgProfile = await seedConnectionProfile({ orgId: ctx.orgId, name: "Temp" });

      // Set then delete the profile
      await app.request("/api/flows/@myorg/detail-del/org-profile", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ orgProfileId: orgProfile.id }),
      });
      await app.request(`/api/connection-profiles/org/${orgProfile.id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      const res = await app.request("/api/packages/flows/@myorg/detail-del", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.flow.flowOrgProfileId).toBeNull();
      expect(body.flow.flowOrgProfileName).toBeNull();
    });
  });
});
