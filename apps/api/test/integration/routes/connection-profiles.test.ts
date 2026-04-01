import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  addOrgMember,
  createTestUser,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedConnectionProfile, seedFlow } from "../../helpers/seed.ts";

const app = getTestApp();

describe("Connection Profiles API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  describe("GET /api/connection-profiles", () => {
    it("returns profiles list", async () => {
      const res = await app.request("/api/connection-profiles", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.profiles).toBeArray();
    });
  });

  describe("POST /api/connection-profiles", () => {
    it("creates a new profile", async () => {
      const res = await app.request("/api/connection-profiles", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Work Profile" }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.profile).toBeDefined();
      expect(body.profile.name).toBe("Work Profile");
    });

    it("rejects empty name", async () => {
      const res = await app.request("/api/connection-profiles", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "" }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("PUT /api/connection-profiles/:id", () => {
    it("renames a profile", async () => {
      const createRes = await app.request("/api/connection-profiles", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Old Name" }),
      });
      const { profile } = (await createRes.json()) as any;

      const res = await app.request(`/api/connection-profiles/${profile.id}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Name" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
    });
  });

  describe("DELETE /api/connection-profiles/:id", () => {
    it("deletes a profile", async () => {
      const createRes = await app.request("/api/connection-profiles", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "To Delete" }),
      });
      const { profile } = (await createRes.json()) as any;

      const res = await app.request(`/api/connection-profiles/${profile.id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
    });
  });

  // ─── Org Profile Routes ──────────────────────────────────

  describe("GET /api/connection-profiles/org", () => {
    it("returns empty list initially", async () => {
      const res = await app.request("/api/connection-profiles/org", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.profiles).toBeArray();
      expect(body.profiles).toHaveLength(0);
    });

    it("returns created org profiles", async () => {
      await seedConnectionProfile({ orgId: ctx.orgId, name: "Org Profile 1" });

      const res = await app.request("/api/connection-profiles/org", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.profiles).toHaveLength(1);
      expect(body.profiles[0].name).toBe("Org Profile 1");
    });
  });

  describe("POST /api/connection-profiles/org", () => {
    it("creates an org profile (admin/owner)", async () => {
      const res = await app.request("/api/connection-profiles/org", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Production" }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.profile).toBeDefined();
      expect(body.profile.name).toBe("Production");
      expect(body.profile.orgId).toBe(ctx.orgId);
    });

    it("rejects empty name", async () => {
      const res = await app.request("/api/connection-profiles/org", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 403 for non-admin member", async () => {
      const member = await createTestUser();
      await addOrgMember(ctx.orgId, member.id, "member");
      const memberCtx: TestContext = {
        user: { id: member.id, email: member.email, name: member.name },
        org: ctx.org,
        cookie: member.cookie,
        orgId: ctx.orgId,
        defaultAppId: ctx.defaultAppId,
      };

      const res = await app.request("/api/connection-profiles/org", {
        method: "POST",
        headers: { ...authHeaders(memberCtx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Should Fail" }),
      });

      expect(res.status).toBe(403);
    });
  });

  describe("PUT /api/connection-profiles/org/:id", () => {
    it("renames an org profile", async () => {
      const profile = await seedConnectionProfile({ orgId: ctx.orgId, name: "Old Org Name" });

      const res = await app.request(`/api/connection-profiles/org/${profile.id}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Org Name" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
    });
  });

  describe("DELETE /api/connection-profiles/org/:id", () => {
    it("deletes an org profile", async () => {
      const profile = await seedConnectionProfile({ orgId: ctx.orgId, name: "To Delete" });

      const res = await app.request(`/api/connection-profiles/org/${profile.id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
    });

    it("returns 400 for profile from another org", async () => {
      const otherCtx = await createTestContext();
      const otherProfile = await seedConnectionProfile({
        orgId: otherCtx.orgId,
        name: "Other Org",
      });

      const res = await app.request(`/api/connection-profiles/org/${otherProfile.id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      // Should fail because the profile doesn't belong to ctx's org
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/connection-profiles/org/:id/flows", () => {
    it("returns flows configured with the org profile", async () => {
      const orgProfile = await seedConnectionProfile({ orgId: ctx.orgId, name: "Prod Profile" });
      await seedFlow({
        id: "@testorg/linked-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@testorg/linked-flow",
          version: "0.1.0",
          type: "flow",
          description: "Test",
          displayName: "Linked Flow",
        },
      });

      // Set org profile on the flow
      const setRes = await app.request("/api/flows/@testorg/linked-flow/org-profile", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ orgProfileId: orgProfile.id }),
      });
      expect(setRes.status).toBe(200);

      const res = await app.request(`/api/connection-profiles/org/${orgProfile.id}/flows`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.flows).toBeArray();
      expect(body.flows).toHaveLength(1);
      expect(body.flows[0].id).toBe("@testorg/linked-flow");
      expect(body.flows[0].displayName).toBe("Linked Flow");
    });

    it("returns empty array when no flows use the profile", async () => {
      const orgProfile = await seedConnectionProfile({ orgId: ctx.orgId, name: "Unused" });

      const res = await app.request(`/api/connection-profiles/org/${orgProfile.id}/flows`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.flows).toHaveLength(0);
    });

    it("returns 404 for non-existent profile", async () => {
      const res = await app.request(
        "/api/connection-profiles/org/00000000-0000-0000-0000-000000000000/flows",
        { headers: authHeaders(ctx) },
      );

      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/connection-profiles/org/:id/bindings", () => {
    it("returns empty bindings for a new org profile", async () => {
      const profile = await seedConnectionProfile({ orgId: ctx.orgId, name: "Org Profile" });

      const res = await app.request(`/api/connection-profiles/org/${profile.id}/bindings`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.bindings).toBeArray();
      expect(body.bindings).toHaveLength(0);
    });

    it("returns 404 for unknown profile", async () => {
      const res = await app.request(
        `/api/connection-profiles/org/00000000-0000-0000-0000-000000000000/bindings`,
        { headers: authHeaders(ctx) },
      );

      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/connection-profiles/org/:id/bind", () => {
    it("rejects bind with missing providerId", async () => {
      const orgProfile = await seedConnectionProfile({ orgId: ctx.orgId, name: "Org" });
      const userProfile = await seedConnectionProfile({
        userId: ctx.user.id,
        name: "User Profile",
      });

      const res = await app.request(`/api/connection-profiles/org/${orgProfile.id}/bind`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ sourceProfileId: userProfile.id }),
      });

      expect(res.status).toBe(400);
    });

    it("rejects bind with source profile that doesn't belong to the user", async () => {
      const orgProfile = await seedConnectionProfile({ orgId: ctx.orgId, name: "Org" });
      const otherCtx = await createTestContext();
      const otherProfile = await seedConnectionProfile({
        userId: otherCtx.user.id,
        name: "Other User",
      });

      const res = await app.request(`/api/connection-profiles/org/${orgProfile.id}/bind`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: "@appstrate/gmail",
          sourceProfileId: otherProfile.id,
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/connection-profiles/org/:id/bind/:provider", () => {
    it("returns 404 for unknown org profile", async () => {
      const res = await app.request(
        `/api/connection-profiles/org/00000000-0000-0000-0000-000000000000/bind/@appstrate/gmail`,
        {
          method: "DELETE",
          headers: authHeaders(ctx),
        },
      );

      expect(res.status).toBe(404);
    });

    it("succeeds on unbind even when no binding exists (idempotent)", async () => {
      const orgProfile = await seedConnectionProfile({ orgId: ctx.orgId, name: "Org" });

      const res = await app.request(
        `/api/connection-profiles/org/${orgProfile.id}/bind/@appstrate/gmail`,
        {
          method: "DELETE",
          headers: authHeaders(ctx),
        },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.unbound).toBe(true);
    });
  });
});
