// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  addOrgMember,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedConnectionProfile } from "../../helpers/seed.ts";

const app = getTestApp();

describe("Multi-org profile isolation", () => {
  let ctxA: TestContext;
  let ctxB: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctxA = await createTestContext({ orgSlug: "org-alpha" });
    ctxB = await createTestContext({ orgSlug: "org-beta" });
  });

  // ─── App Profile Isolation ──────────────────────────────────

  describe("app profile visibility", () => {
    it("org A cannot see org B's app profiles", async () => {
      const profileB = await seedConnectionProfile({
        applicationId: ctxB.defaultAppId,
        name: "Beta Production",
      });

      // Org A lists app profiles — should not see Beta's profile
      const res = await app.request("/api/app-profiles", {
        headers: authHeaders(ctxA),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const leaked = body.data.find((p: { id: string }) => p.id === profileB.id);
      expect(leaked).toBeUndefined();
    });

    it("org A cannot access org B's profile detail via bindings endpoint", async () => {
      const profileB = await seedConnectionProfile({
        applicationId: ctxB.defaultAppId,
        name: "Beta Secret",
      });

      const res = await app.request(`/api/app-profiles/${profileB.id}/bindings`, {
        headers: authHeaders(ctxA),
      });

      // Should return 404 because the profile does not belong to org A
      expect(res.status).toBe(404);
    });

    it("org A cannot access org B's profile agents endpoint", async () => {
      const profileB = await seedConnectionProfile({
        applicationId: ctxB.defaultAppId,
        name: "Beta Agents",
      });

      const res = await app.request(`/api/app-profiles/${profileB.id}/agents`, {
        headers: authHeaders(ctxA),
      });

      expect(res.status).toBe(404);
    });

    it("org A cannot delete org B's profile", async () => {
      const profileB = await seedConnectionProfile({
        applicationId: ctxB.defaultAppId,
        name: "Beta To Delete",
      });

      const res = await app.request(`/api/app-profiles/${profileB.id}`, {
        method: "DELETE",
        headers: authHeaders(ctxA),
      });

      // Should fail — the profile does not belong to org A
      expect([400, 404]).toContain(res.status);

      // Verify the profile still exists via org B
      const checkRes = await app.request("/api/app-profiles", {
        headers: authHeaders(ctxB),
      });
      const checkBody = (await checkRes.json()) as any;
      const stillExists = checkBody.profiles.find((p: { id: string }) => p.id === profileB.id);
      expect(stillExists).toBeDefined();
    });

    it("org A cannot rename org B's profile", async () => {
      const profileB = await seedConnectionProfile({
        applicationId: ctxB.defaultAppId,
        name: "Beta Original",
      });

      const res = await app.request(`/api/app-profiles/${profileB.id}`, {
        method: "PUT",
        headers: { ...authHeaders(ctxA), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Hacked" }),
      });

      expect([400, 404]).toContain(res.status);
    });
  });

  // ─── App Profile Binding Isolation ──────────────────────────

  describe("app profile binding isolation", () => {
    it("org A cannot bind using org B's app profile", async () => {
      const profileB = await seedConnectionProfile({
        applicationId: ctxB.defaultAppId,
        name: "Beta App Profile",
      });
      const userProfileA = await seedConnectionProfile({
        userId: ctxA.user.id,
        name: "Alpha User",
      });

      const res = await app.request(`/api/app-profiles/${profileB.id}/bind`, {
        method: "POST",
        headers: { ...authHeaders(ctxA), "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: "@appstrate/gmail",
          sourceProfileId: userProfileA.id,
        }),
      });

      // Should fail because profileB belongs to org B, not org A
      expect([400, 404]).toContain(res.status);
    });

    it("org A cannot unbind from org B's app profile", async () => {
      const profileB = await seedConnectionProfile({
        applicationId: ctxB.defaultAppId,
        name: "Beta App Profile",
      });

      const res = await app.request(`/api/app-profiles/${profileB.id}/bind/@appstrate/gmail`, {
        method: "DELETE",
        headers: authHeaders(ctxA),
      });

      // Should return 404 because the profile does not belong to org A
      expect(res.status).toBe(404);
    });

    it("org A cannot bind with org B's user profile as source", async () => {
      const appProfileA = await seedConnectionProfile({
        applicationId: ctxA.defaultAppId,
        name: "Alpha App Profile",
      });
      const userProfileB = await seedConnectionProfile({
        userId: ctxB.user.id,
        name: "Beta User",
      });

      const res = await app.request(`/api/app-profiles/${appProfileA.id}/bind`, {
        method: "POST",
        headers: { ...authHeaders(ctxA), "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: "@appstrate/gmail",
          sourceProfileId: userProfileB.id,
        }),
      });

      // Should fail because the source profile belongs to a different user
      expect(res.status).toBe(400);
    });
  });

  // ─── User Profile Isolation (same org, different users) ─────

  describe("user profile isolation within same org", () => {
    it("member cannot see another member's user profiles", async () => {
      const member = await createTestUser({ email: "member@test.com" });
      await addOrgMember(ctxA.orgId, member.id, "member");
      const memberCtx: TestContext = {
        user: { id: member.id, email: member.email, name: member.name },
        org: ctxA.org,
        cookie: member.cookie,
        orgId: ctxA.orgId,
        defaultAppId: ctxA.defaultAppId,
      };

      // Seed a profile for the original user
      await seedConnectionProfile({ userId: ctxA.user.id, name: "Owner Private" });

      // Member lists their own profiles — should only see their own default
      const res = await app.request("/api/connection-profiles", {
        headers: authHeaders(memberCtx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const leaked = body.data.find((p: { name: string }) => p.name === "Owner Private");
      expect(leaked).toBeUndefined();
    });

    it("both members can see shared app profiles", async () => {
      const member = await createTestUser({ email: "member2@test.com" });
      await addOrgMember(ctxA.orgId, member.id, "member");
      const memberCtx: TestContext = {
        user: { id: member.id, email: member.email, name: member.name },
        org: ctxA.org,
        cookie: member.cookie,
        orgId: ctxA.orgId,
        defaultAppId: ctxA.defaultAppId,
      };

      const appProfile = await seedConnectionProfile({
        applicationId: ctxA.defaultAppId,
        name: "Shared App",
      });

      // Both owner and member should see the app profile
      const ownerRes = await app.request("/api/app-profiles", {
        headers: authHeaders(ctxA),
      });
      const memberRes = await app.request("/api/app-profiles", {
        headers: authHeaders(memberCtx),
      });

      expect(ownerRes.status).toBe(200);
      expect(memberRes.status).toBe(200);

      const ownerBody = (await ownerRes.json()) as any;
      const memberBody = (await memberRes.json()) as any;

      const ownerSees = ownerBody.profiles.find((p: { id: string }) => p.id === appProfile.id);
      const memberSees = memberBody.profiles.find((p: { id: string }) => p.id === appProfile.id);

      expect(ownerSees).toBeDefined();
      expect(memberSees).toBeDefined();
    });
  });
});
