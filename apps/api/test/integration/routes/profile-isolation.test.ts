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

  // ─── Org Profile Isolation ──────────────────────────────────

  describe("org profile visibility", () => {
    it("org A cannot see org B's org profiles", async () => {
      const profileB = await seedConnectionProfile({
        orgId: ctxB.orgId,
        name: "Beta Production",
      });

      // Org A lists org profiles — should not see Beta's profile
      const res = await app.request("/api/connection-profiles/org", {
        headers: authHeaders(ctxA),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const leaked = body.profiles.find((p: { id: string }) => p.id === profileB.id);
      expect(leaked).toBeUndefined();
    });

    it("org A cannot access org B's profile detail via bindings endpoint", async () => {
      const profileB = await seedConnectionProfile({
        orgId: ctxB.orgId,
        name: "Beta Secret",
      });

      const res = await app.request(`/api/connection-profiles/org/${profileB.id}/bindings`, {
        headers: authHeaders(ctxA),
      });

      // Should return 404 because the profile does not belong to org A
      expect(res.status).toBe(404);
    });

    it("org A cannot access org B's profile agents endpoint", async () => {
      const profileB = await seedConnectionProfile({
        orgId: ctxB.orgId,
        name: "Beta Agents",
      });

      const res = await app.request(`/api/connection-profiles/org/${profileB.id}/agents`, {
        headers: authHeaders(ctxA),
      });

      expect(res.status).toBe(404);
    });

    it("org A cannot delete org B's profile", async () => {
      const profileB = await seedConnectionProfile({
        orgId: ctxB.orgId,
        name: "Beta To Delete",
      });

      const res = await app.request(`/api/connection-profiles/org/${profileB.id}`, {
        method: "DELETE",
        headers: authHeaders(ctxA),
      });

      // Should fail — the profile does not belong to org A
      expect([400, 404]).toContain(res.status);

      // Verify the profile still exists via org B
      const checkRes = await app.request("/api/connection-profiles/org", {
        headers: authHeaders(ctxB),
      });
      const checkBody = (await checkRes.json()) as any;
      const stillExists = checkBody.profiles.find((p: { id: string }) => p.id === profileB.id);
      expect(stillExists).toBeDefined();
    });

    it("org A cannot rename org B's profile", async () => {
      const profileB = await seedConnectionProfile({
        orgId: ctxB.orgId,
        name: "Beta Original",
      });

      const res = await app.request(`/api/connection-profiles/org/${profileB.id}`, {
        method: "PUT",
        headers: { ...authHeaders(ctxA), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Hacked" }),
      });

      expect([400, 404]).toContain(res.status);
    });
  });

  // ─── Org Profile Binding Isolation ──────────────────────────

  describe("org profile binding isolation", () => {
    it("org A cannot bind using org B's org profile", async () => {
      const profileB = await seedConnectionProfile({
        orgId: ctxB.orgId,
        name: "Beta Org Profile",
      });
      const userProfileA = await seedConnectionProfile({
        userId: ctxA.user.id,
        name: "Alpha User",
      });

      const res = await app.request(`/api/connection-profiles/org/${profileB.id}/bind`, {
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

    it("org A cannot unbind from org B's org profile", async () => {
      const profileB = await seedConnectionProfile({
        orgId: ctxB.orgId,
        name: "Beta Org Profile",
      });

      const res = await app.request(
        `/api/connection-profiles/org/${profileB.id}/bind/@appstrate/gmail`,
        {
          method: "DELETE",
          headers: authHeaders(ctxA),
        },
      );

      // Should return 404 because the profile does not belong to org A
      expect(res.status).toBe(404);
    });

    it("org A cannot bind with org B's user profile as source", async () => {
      const orgProfileA = await seedConnectionProfile({
        orgId: ctxA.orgId,
        name: "Alpha Org Profile",
      });
      const userProfileB = await seedConnectionProfile({
        userId: ctxB.user.id,
        name: "Beta User",
      });

      const res = await app.request(`/api/connection-profiles/org/${orgProfileA.id}/bind`, {
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
      const leaked = body.profiles.find((p: { name: string }) => p.name === "Owner Private");
      expect(leaked).toBeUndefined();
    });

    it("both members can see shared org profiles", async () => {
      const member = await createTestUser({ email: "member2@test.com" });
      await addOrgMember(ctxA.orgId, member.id, "member");
      const memberCtx: TestContext = {
        user: { id: member.id, email: member.email, name: member.name },
        org: ctxA.org,
        cookie: member.cookie,
        orgId: ctxA.orgId,
        defaultAppId: ctxA.defaultAppId,
      };

      const orgProfile = await seedConnectionProfile({
        orgId: ctxA.orgId,
        name: "Shared Org",
      });

      // Both owner and member should see the org profile
      const ownerRes = await app.request("/api/connection-profiles/org", {
        headers: authHeaders(ctxA),
      });
      const memberRes = await app.request("/api/connection-profiles/org", {
        headers: authHeaders(memberCtx),
      });

      expect(ownerRes.status).toBe(200);
      expect(memberRes.status).toBe(200);

      const ownerBody = (await ownerRes.json()) as any;
      const memberBody = (await memberRes.json()) as any;

      const ownerSees = ownerBody.profiles.find((p: { id: string }) => p.id === orgProfile.id);
      const memberSees = memberBody.profiles.find((p: { id: string }) => p.id === orgProfile.id);

      expect(ownerSees).toBeDefined();
      expect(memberSees).toBeDefined();
    });
  });
});
