// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import {
  createTestUser,
  createTestContext,
  createTestOrg,
  addOrgMember,
  authHeaders,
} from "../../helpers/auth.ts";
import { seedApiKey } from "../../helpers/seed.ts";
import { assertDbHas } from "../../helpers/assertions.ts";
import { organizations, orgInvitations, organizationMembers } from "@appstrate/db/schema";
import { CURRENT_API_VERSION } from "../../../src/lib/api-versions.ts";
import { getOrgSettings } from "../../../src/services/organizations.ts";

const app = getTestApp();

describe("Organizations API", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  describe("GET /api/orgs", () => {
    it("returns user organizations", async () => {
      const ctx = await createTestContext({ orgName: "My Org" });

      const res = await app.request("/api/orgs", {
        headers: { Cookie: ctx.cookie },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.organizations).toBeArray();
      expect(body.organizations.length).toBeGreaterThanOrEqual(1);
      const org = body.organizations.find((o: { id: string }) => o.id === ctx.orgId);
      expect(org).toBeDefined();
      expect(org.name).toBe("My Org");
      expect(org.role).toBe("owner");
    });

    it("returns empty list for new user without orgs", async () => {
      const testUser = await createTestUser();

      const res = await app.request("/api/orgs", {
        headers: { Cookie: testUser.cookie },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.organizations).toBeArray();
      expect(body.organizations).toHaveLength(0);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/orgs");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/orgs", () => {
    it("creates a new organization", async () => {
      const testUser = await createTestUser();

      const res = await app.request("/api/orgs", {
        method: "POST",
        headers: {
          Cookie: testUser.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "New Org", slug: "new-org" }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.name).toBe("New Org");
      expect(body.slug).toBe("new-org");
      expect(body.role).toBe("owner");

      // Verify org exists in DB
      await assertDbHas(organizations, eq(organizations.slug, "new-org"));
    });

    it("rejects duplicate slug with 400", async () => {
      await createTestContext({ orgSlug: "taken-slug" });
      const otherUser = await createTestUser();

      const res = await app.request("/api/orgs", {
        method: "POST",
        headers: {
          Cookie: otherUser.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Another Org", slug: "taken-slug" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.code).toBe("slug_taken");
    });

    it("pins apiVersion in settings at creation", async () => {
      const testUser = await createTestUser();

      const res = await app.request("/api/orgs", {
        method: "POST",
        headers: {
          Cookie: testUser.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Pinned Org", slug: "pinned-org" }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;

      const settings = await getOrgSettings(body.id);
      expect(settings.apiVersion).toBe(CURRENT_API_VERSION);
    });

    it("rejects missing name", async () => {
      const testUser = await createTestUser();

      const res = await app.request("/api/orgs", {
        method: "POST",
        headers: {
          Cookie: testUser.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "" }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/orgs/:orgId (org detail)", () => {
    it("returns org details for member", async () => {
      const ctx = await createTestContext();

      const res = await app.request(`/api/orgs/${ctx.orgId}`, {
        headers: { Cookie: ctx.cookie },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe(ctx.orgId);
      expect(body.members).toBeArray();
      expect(body.members).toHaveLength(1); // owner
    });

    it("includes multiple members", async () => {
      const ctx = await createTestContext();
      const member = await createTestUser();
      await addOrgMember(ctx.orgId, member.id, "member");

      const res = await app.request(`/api/orgs/${ctx.orgId}`, {
        headers: { Cookie: ctx.cookie },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.members).toHaveLength(2);
    });

    it("rejects non-member access with 403", async () => {
      const ctx = await createTestContext();
      const outsider = await createTestUser();

      const res = await app.request(`/api/orgs/${ctx.orgId}`, {
        headers: { Cookie: outsider.cookie },
      });

      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/orgs/:orgId/members", () => {
    it("adds existing user directly when SMTP is disabled", async () => {
      const ctx = await createTestContext({ orgSlug: "memberorg" });
      const member = await createTestUser({ email: "member@test.com" });

      const res = await app.request(`/api/orgs/${ctx.orgId}/members`, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ email: "member@test.com", role: "member" }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.added).toBe(true);
      expect(body.userId).toBe(member.id);
      expect(body.role).toBe("member");

      // Verify membership in DB
      await assertDbHas(organizationMembers, eq(organizationMembers.userId, member.id));
    });

    it("creates invitation for non-existing user", async () => {
      const ctx = await createTestContext({ orgSlug: "memberorg" });
      const res = await app.request(`/api/orgs/${ctx.orgId}/members`, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ email: "newuser@test.com", role: "admin" }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.invited).toBe(true);
      expect(body.email).toBe("newuser@test.com");
      expect(body.role).toBe("admin");

      // Verify invitation in DB
      await assertDbHas(orgInvitations, eq(orgInvitations.email, "newuser@test.com"));
    });

    it("rejects invalid email", async () => {
      const ctx = await createTestContext({ orgSlug: "memberorg" });
      const res = await app.request(`/api/orgs/${ctx.orgId}/members`, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ email: "not-an-email" }),
      });

      expect(res.status).toBe(400);
    });

    it("handles adding already existing member gracefully", async () => {
      const ctx = await createTestContext({ orgSlug: "memberorg" });
      const member = await createTestUser({ email: "already@test.com" });
      await addOrgMember(ctx.orgId, member.id, "member");

      const res = await app.request(`/api/orgs/${ctx.orgId}/members`, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ email: "already@test.com" }),
      });

      // addMember is idempotent — duplicate silently ignored, returns 201
      expect(res.status).toBe(201);
    });
  });

  // Issue #172 — API keys must stay confined to their bound organization.
  // Setup: a user belongs to two orgs (A + B); a key issued in A must
  // never be able to read, enumerate, or mutate B.
  describe("API key org scope (issue #172)", () => {
    async function setupTwoOrgKey() {
      const ctxA = await createTestContext({ orgSlug: "org-a-172" });
      const orgB = await createTestOrg(ctxA.user.id, { slug: "org-b-172" });
      const apiKey = await seedApiKey({
        orgId: ctxA.orgId,
        applicationId: ctxA.defaultAppId,
        createdBy: ctxA.user.id,
        scopes: ["agents:read", "applications:read", "applications:write", "applications:delete"],
      });
      return {
        ctxA,
        orgB: orgB.org,
        bearer: { Authorization: `Bearer ${apiKey.rawKey}` },
      };
    }

    it("GET /api/orgs returns only the key's org", async () => {
      const { ctxA, orgB, bearer } = await setupTwoOrgKey();

      const res = await app.request("/api/orgs", { headers: bearer });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { organizations: { id: string }[] };
      const ids = body.organizations.map((o) => o.id);
      expect(ids).toContain(ctxA.orgId);
      expect(ids).not.toContain(orgB.id);
      expect(body.organizations).toHaveLength(1);
    });

    it("GET /api/orgs/:keyOrgId still works", async () => {
      const { ctxA, bearer } = await setupTwoOrgKey();
      const res = await app.request(`/api/orgs/${ctxA.orgId}`, { headers: bearer });
      expect(res.status).toBe(200);
    });

    it("GET /api/orgs/:otherOrgId returns 403", async () => {
      const { orgB, bearer } = await setupTwoOrgKey();
      const res = await app.request(`/api/orgs/${orgB.id}`, { headers: bearer });
      expect(res.status).toBe(403);
    });

    it("PUT /api/orgs/:otherOrgId returns 403 and does not mutate", async () => {
      const { orgB, bearer } = await setupTwoOrgKey();
      const res = await app.request(`/api/orgs/${orgB.id}`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "PWNED" }),
      });
      expect(res.status).toBe(403);
      const [row] = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, orgB.id));
      expect(row?.name).not.toBe("PWNED");
    });

    it("DELETE /api/orgs/:otherOrgId returns 403 and org B still exists", async () => {
      const { orgB, bearer } = await setupTwoOrgKey();
      const res = await app.request(`/api/orgs/${orgB.id}`, {
        method: "DELETE",
        headers: bearer,
      });
      expect(res.status).toBe(403);
      await assertDbHas(organizations, eq(organizations.id, orgB.id));
    });

    it("POST /api/orgs returns 403 — API keys cannot create orgs", async () => {
      const { bearer } = await setupTwoOrgKey();
      const res = await app.request("/api/orgs", {
        method: "POST",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Pwn Org", slug: "pwn-org" }),
      });
      expect(res.status).toBe(403);
    });

    it("POST /api/orgs/:otherOrgId/members returns 403", async () => {
      const { orgB, bearer } = await setupTwoOrgKey();
      const res = await app.request(`/api/orgs/${orgB.id}/members`, {
        method: "POST",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "attacker@test.com", role: "admin" }),
      });
      expect(res.status).toBe(403);
    });

    it("PUT /api/orgs/:otherOrgId/members/:userId returns 403", async () => {
      const { orgB, bearer, ctxA } = await setupTwoOrgKey();
      const res = await app.request(`/api/orgs/${orgB.id}/members/${ctxA.user.id}`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      });
      expect(res.status).toBe(403);
    });

    it("DELETE /api/orgs/:otherOrgId/members/:userId returns 403", async () => {
      const { orgB, bearer, ctxA } = await setupTwoOrgKey();
      const res = await app.request(`/api/orgs/${orgB.id}/members/${ctxA.user.id}`, {
        method: "DELETE",
        headers: bearer,
      });
      expect(res.status).toBe(403);
    });

    it("PUT /api/orgs/:otherOrgId/invitations/:invId returns 403", async () => {
      const { orgB, bearer } = await setupTwoOrgKey();
      const res = await app.request(`/api/orgs/${orgB.id}/invitations/inv_x`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "owner" }),
      });
      expect(res.status).toBe(403);
    });

    it("DELETE /api/orgs/:otherOrgId/invitations/:invId returns 403", async () => {
      const { orgB, bearer } = await setupTwoOrgKey();
      const res = await app.request(`/api/orgs/${orgB.id}/invitations/inv_x`, {
        method: "DELETE",
        headers: bearer,
      });
      expect(res.status).toBe(403);
    });

    it("GET /api/orgs/:otherOrgId/settings returns 403", async () => {
      const { orgB, bearer } = await setupTwoOrgKey();
      const res = await app.request(`/api/orgs/${orgB.id}/settings`, { headers: bearer });
      expect(res.status).toBe(403);
    });

    it("PUT /api/orgs/:otherOrgId/settings returns 403", async () => {
      const { orgB, bearer } = await setupTwoOrgKey();
      const res = await app.request(`/api/orgs/${orgB.id}/settings`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ apiVersion: "2026-03-21" }),
      });
      expect(res.status).toBe(403);
    });

    it("session cookie still sees both orgs (regression guard)", async () => {
      const { ctxA, orgB } = await setupTwoOrgKey();
      const res = await app.request("/api/orgs", {
        headers: { Cookie: ctxA.cookie },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { organizations: { id: string }[] };
      const ids = body.organizations.map((o) => o.id);
      expect(ids).toContain(ctxA.orgId);
      expect(ids).toContain(orgB.id);
    });
  });
});
