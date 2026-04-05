// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import {
  createTestContext,
  addOrgMember,
  createTestUser,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedConnectionProfile, seedAgent, seedPackage } from "../../helpers/seed.ts";
import { applicationProviderCredentials } from "@appstrate/db/schema";

const app = getTestApp();

/**
 * Seed a provider package and enable it for an org.
 * Required for connect route tests where `isProviderEnabled` is checked before ownership.
 */
async function seedEnabledProvider(
  providerId: string,
  orgId: string,
  createdBy: string,
  applicationId: string,
) {
  await seedPackage({
    id: providerId,
    orgId,
    type: "provider",
    createdBy,
    draftManifest: {
      name: providerId,
      type: "provider",
      version: "1.0.0",
      description: "Test provider",
      definition: {
        authMode: "api_key",
        authorizedUris: [],
        allowAllUris: true,
        credentials: {
          schema: {
            type: "object",
            properties: { apiKey: { type: "string" } },
            required: ["apiKey"],
          },
          fieldName: "apiKey",
        },
        credentialHeaderName: "Authorization",
        credentialHeaderPrefix: "Bearer ",
      },
    },
  });
  await db.insert(applicationProviderCredentials).values({
    applicationId,
    providerId,
    credentialsEncrypted: "{}",
    enabled: true,
  });
}

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

  describe("GET /api/connection-profiles/org/:id/agents", () => {
    it("returns agents configured with the org profile", async () => {
      const orgProfile = await seedConnectionProfile({ orgId: ctx.orgId, name: "Prod Profile" });
      await seedAgent({
        id: "@testorg/linked-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@testorg/linked-agent",
          version: "0.1.0",
          type: "agent",
          description: "Test",
          displayName: "Linked Agent",
        },
      });

      // Set org profile on the agent
      const setRes = await app.request("/api/agents/@testorg/linked-agent/org-profile", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ orgProfileId: orgProfile.id }),
      });
      expect(setRes.status).toBe(200);

      const res = await app.request(`/api/connection-profiles/org/${orgProfile.id}/agents`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.agents).toBeArray();
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0].id).toBe("@testorg/linked-agent");
      expect(body.agents[0].displayName).toBe("Linked Agent");
    });

    it("returns empty array when no agents use the profile", async () => {
      const orgProfile = await seedConnectionProfile({ orgId: ctx.orgId, name: "Unused" });

      const res = await app.request(`/api/connection-profiles/org/${orgProfile.id}/agents`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.agents).toHaveLength(0);
    });

    it("returns 404 for non-existent profile", async () => {
      const res = await app.request(
        "/api/connection-profiles/org/00000000-0000-0000-0000-000000000000/agents",
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

  // ─── Cross-Member Profile Connection Viewing ─────────────

  describe("GET /api/connection-profiles/:id/connections (cross-member)", () => {
    it("returns connections for another org member's profile", async () => {
      // user1 (ctx) is the profile owner
      const user1Profile = await seedConnectionProfile({
        userId: ctx.user.id,
        name: "User1 Profile",
      });

      // Create user2 in the same org
      const user2 = await createTestUser();
      await addOrgMember(ctx.orgId, user2.id, "member");
      const user2Ctx: TestContext = {
        user: { id: user2.id, email: user2.email, name: user2.name },
        org: ctx.org,
        cookie: user2.cookie,
        orgId: ctx.orgId,
        defaultAppId: ctx.defaultAppId,
      };

      // user2 views user1's profile connections
      const res = await app.request(`/api/connection-profiles/${user1Profile.id}/connections`, {
        headers: authHeaders(user2Ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.connections).toBeArray();
    });

    it("returns 404 for a profile from a non-member", async () => {
      // Create two separate orgs with separate users
      const org1Ctx = ctx;
      const org2Ctx = await createTestContext();

      // Create a profile in org1
      const org1Profile = await seedConnectionProfile({
        userId: org1Ctx.user.id,
        name: "Org1 User Profile",
      });

      // User from org2 tries to view org1 user's profile connections
      const res = await app.request(`/api/connection-profiles/${org1Profile.id}/connections`, {
        headers: authHeaders(org2Ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns connections for own profile", async () => {
      const ownProfile = await seedConnectionProfile({
        userId: ctx.user.id,
        name: "My Profile",
      });

      const res = await app.request(`/api/connection-profiles/${ownProfile.id}/connections`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.connections).toBeArray();
    });

    it("returns connections for an org-level profile in the same org", async () => {
      const orgProfile = await seedConnectionProfile({
        orgId: ctx.orgId,
        name: "Org Shared Profile",
      });

      const res = await app.request(`/api/connection-profiles/${orgProfile.id}/connections`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.connections).toBeArray();
    });

    it("returns 404 for a non-existent profile", async () => {
      const res = await app.request(
        "/api/connection-profiles/00000000-0000-0000-0000-000000000000/connections",
        { headers: authHeaders(ctx) },
      );

      expect(res.status).toBe(404);
    });
  });

  // ─── Profile Ownership on Connect Routes ─────────────────

  describe("POST /api/connections/connect/:provider (ownership)", () => {
    it("rejects connecting on another user's profile with 403", async () => {
      const providerId = "@testorg/test-provider";
      await seedEnabledProvider(providerId, ctx.orgId, ctx.user.id, ctx.defaultAppId);

      // user1 (ctx) owns the profile
      const user1Profile = await seedConnectionProfile({
        userId: ctx.user.id,
        name: "User1 Profile",
      });

      // Create user2 in the same org
      const user2 = await createTestUser();
      await addOrgMember(ctx.orgId, user2.id, "member");
      const user2Ctx: TestContext = {
        user: { id: user2.id, email: user2.email, name: user2.name },
        org: ctx.org,
        cookie: user2.cookie,
        orgId: ctx.orgId,
        defaultAppId: ctx.defaultAppId,
      };

      // user2 tries to connect on user1's profile
      const res = await app.request(`/api/connections/connect/${providerId}`, {
        method: "POST",
        headers: { ...authHeaders(user2Ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: user1Profile.id }),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as any;
      expect(body.detail).toContain("profile you do not own");
    });

    it("accepts connecting on an org profile", async () => {
      const providerId = "@testorg/test-provider-org";
      await seedEnabledProvider(providerId, ctx.orgId, ctx.user.id, ctx.defaultAppId);

      const orgProfile = await seedConnectionProfile({
        orgId: ctx.orgId,
        name: "Org Profile",
      });

      const res = await app.request(`/api/connections/connect/${providerId}`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: orgProfile.id }),
      });

      // Should not get 403 — ownership check passes for org profiles
      expect(res.status).not.toBe(403);
    });

    it("does not return 403 when connecting on own profile", async () => {
      const providerId = "@testorg/test-provider-own";
      await seedEnabledProvider(providerId, ctx.orgId, ctx.user.id, ctx.defaultAppId);

      const ownProfile = await seedConnectionProfile({
        userId: ctx.user.id,
        name: "My Profile",
      });

      // Attempt to connect on own profile — should not get ownership rejection.
      // May fail deeper in the OAuth flow (no real OAuth server), but the
      // ownership check itself should pass.
      const res = await app.request(`/api/connections/connect/${providerId}`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: ownProfile.id }),
      });

      // 403 with "profile you do not own" means the ownership check failed
      expect(res.status).not.toBe(403);
    });
  });

  describe("POST /api/connections/connect/:provider/api-key (ownership)", () => {
    it("rejects saving an API key on another user's profile with 403", async () => {
      const providerId = "@testorg/apikey-provider";
      await seedEnabledProvider(providerId, ctx.orgId, ctx.user.id, ctx.defaultAppId);

      const user1Profile = await seedConnectionProfile({
        userId: ctx.user.id,
        name: "User1 Profile",
      });

      const user2 = await createTestUser();
      await addOrgMember(ctx.orgId, user2.id, "member");
      const user2Ctx: TestContext = {
        user: { id: user2.id, email: user2.email, name: user2.name },
        org: ctx.org,
        cookie: user2.cookie,
        orgId: ctx.orgId,
        defaultAppId: ctx.defaultAppId,
      };

      const res = await app.request(`/api/connections/connect/${providerId}/api-key`, {
        method: "POST",
        headers: { ...authHeaders(user2Ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "fake-key-123", profileId: user1Profile.id }),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as any;
      expect(body.detail).toContain("profile you do not own");
    });

    it("accepts saving an API key on an org profile", async () => {
      const providerId = "@testorg/apikey-provider-org";
      await seedEnabledProvider(providerId, ctx.orgId, ctx.user.id, ctx.defaultAppId);

      const orgProfile = await seedConnectionProfile({
        orgId: ctx.orgId,
        name: "Org Profile",
      });

      const res = await app.request(`/api/connections/connect/${providerId}/api-key`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "test-key-123", profileId: orgProfile.id }),
      });

      expect(res.status).not.toBe(403);
    });
  });

  describe("POST /api/connections/connect/:provider/credentials (ownership)", () => {
    it("rejects saving credentials on another user's profile with 403", async () => {
      const providerId = "@testorg/creds-provider";
      await seedEnabledProvider(providerId, ctx.orgId, ctx.user.id, ctx.defaultAppId);

      const user1Profile = await seedConnectionProfile({
        userId: ctx.user.id,
        name: "User1 Profile",
      });

      const user2 = await createTestUser();
      await addOrgMember(ctx.orgId, user2.id, "member");
      const user2Ctx: TestContext = {
        user: { id: user2.id, email: user2.email, name: user2.name },
        org: ctx.org,
        cookie: user2.cookie,
        orgId: ctx.orgId,
        defaultAppId: ctx.defaultAppId,
      };

      const res = await app.request(`/api/connections/connect/${providerId}/credentials`, {
        method: "POST",
        headers: { ...authHeaders(user2Ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          credentials: { username: "user", password: "pass" },
          profileId: user1Profile.id,
        }),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as any;
      expect(body.detail).toContain("profile you do not own");
    });

    it("accepts saving credentials on an org profile", async () => {
      const providerId = "@testorg/creds-provider-org";
      await seedEnabledProvider(providerId, ctx.orgId, ctx.user.id, ctx.defaultAppId);

      const orgProfile = await seedConnectionProfile({
        orgId: ctx.orgId,
        name: "Org Profile",
      });

      const res = await app.request(`/api/connections/connect/${providerId}/credentials`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          credentials: { username: "user", password: "pass" },
          profileId: orgProfile.id,
        }),
      });

      expect(res.status).not.toBe(403);
    });
  });

  describe("GET /api/connections (ownership)", () => {
    it("rejects listing connections for another user's profile with 403", async () => {
      const user1Profile = await seedConnectionProfile({
        userId: ctx.user.id,
        name: "User1 Profile",
      });

      const user2 = await createTestUser();
      await addOrgMember(ctx.orgId, user2.id, "member");
      const user2Ctx: TestContext = {
        user: { id: user2.id, email: user2.email, name: user2.name },
        org: ctx.org,
        cookie: user2.cookie,
        orgId: ctx.orgId,
        defaultAppId: ctx.defaultAppId,
      };

      const res = await app.request(`/api/connections?profileId=${user1Profile.id}`, {
        headers: authHeaders(user2Ctx),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as any;
      expect(body.detail).toContain("profile you do not own");
    });

    it("allows listing connections for own profile", async () => {
      const ownProfile = await seedConnectionProfile({
        userId: ctx.user.id,
        name: "My Profile",
      });

      const res = await app.request(`/api/connections?profileId=${ownProfile.id}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
    });

    it("allows listing connections for an org profile", async () => {
      const orgProfile = await seedConnectionProfile({
        orgId: ctx.orgId,
        name: "Org Profile",
      });

      const res = await app.request(`/api/connections?profileId=${orgProfile.id}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
    });
  });

  describe("GET /api/connections/integrations (ownership)", () => {
    it("rejects listing integrations for another user's profile with 403", async () => {
      const user1Profile = await seedConnectionProfile({
        userId: ctx.user.id,
        name: "User1 Profile",
      });

      const user2 = await createTestUser();
      await addOrgMember(ctx.orgId, user2.id, "member");
      const user2Ctx: TestContext = {
        user: { id: user2.id, email: user2.email, name: user2.name },
        org: ctx.org,
        cookie: user2.cookie,
        orgId: ctx.orgId,
        defaultAppId: ctx.defaultAppId,
      };

      const res = await app.request(`/api/connections/integrations?profileId=${user1Profile.id}`, {
        headers: authHeaders(user2Ctx),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as any;
      expect(body.detail).toContain("profile you do not own");
    });

    it("allows listing integrations for own profile", async () => {
      const ownProfile = await seedConnectionProfile({
        userId: ctx.user.id,
        name: "My Profile",
      });

      const res = await app.request(`/api/connections/integrations?profileId=${ownProfile.id}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
    });

    it("allows listing integrations for an org profile", async () => {
      const orgProfile = await seedConnectionProfile({
        orgId: ctx.orgId,
        name: "Org Profile",
      });

      const res = await app.request(`/api/connections/integrations?profileId=${orgProfile.id}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
    });
  });
});
