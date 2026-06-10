// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { eq, and } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import {
  createTestUser,
  createTestContext,
  createTestOrg,
  addOrgMember,
  authHeaders,
  orgOnlyHeaders,
} from "../../helpers/auth.ts";
import { createInvitation } from "../../../src/services/invitations.ts";
import { seedApiKey } from "../../helpers/seed.ts";
import { assertDbHas } from "../../helpers/assertions.ts";
import {
  organizations,
  orgInvitations,
  organizationMembers,
  auditEvents,
} from "@appstrate/db/schema";
import { CURRENT_API_VERSION } from "../../../src/lib/api-versions.ts";
import { getOrgSettings } from "../../../src/services/organizations.ts";
import { recordAudit } from "../../../src/services/audit.ts";

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
      expect(body.data).toBeArray();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      const org = body.data.find((o: { id: string }) => o.id === ctx.orgId);
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
      expect(body.data).toBeArray();
      expect(body.data).toHaveLength(0);
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
      expect(settings.api_version).toBe(CURRENT_API_VERSION);
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

    describe("AUTH_DISABLE_ORG_CREATION (issue #228)", () => {
      // Each test toggles env on entry, restores on exit. Reset cache so
      // the per-request `getEnv()` lookup in the route handler picks up
      // the change without rebuilding the full BA singleton.
      const SNAPSHOT = {
        AUTH_DISABLE_ORG_CREATION: process.env.AUTH_DISABLE_ORG_CREATION,
        AUTH_PLATFORM_ADMIN_EMAILS: process.env.AUTH_PLATFORM_ADMIN_EMAILS,
      };
      const reset = async () => {
        const { _resetCacheForTesting } = await import("@appstrate/env");
        _resetCacheForTesting();
      };

      it("blocks non-admin signups from creating an org", async () => {
        const testUser = await createTestUser({ email: "regular@test.com" });
        process.env.AUTH_DISABLE_ORG_CREATION = "true";
        await reset();
        try {
          const res = await app.request("/api/orgs", {
            method: "POST",
            headers: { Cookie: testUser.cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Blocked Org", slug: "blocked-org" }),
          });
          expect(res.status).toBe(403);
        } finally {
          for (const [k, v] of Object.entries(SNAPSHOT)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
          }
          await reset();
        }
      });

      it("allows platform admins to create orgs even when locked down", async () => {
        const adminEmail = "admin@example.com";
        const adminUser = await createTestUser({ email: adminEmail });
        process.env.AUTH_DISABLE_ORG_CREATION = "true";
        process.env.AUTH_PLATFORM_ADMIN_EMAILS = adminEmail;
        await reset();
        try {
          const res = await app.request("/api/orgs", {
            method: "POST",
            headers: { Cookie: adminUser.cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Admin Org", slug: "admin-org" }),
          });
          expect(res.status).toBe(201);
        } finally {
          for (const [k, v] of Object.entries(SNAPSHOT)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
          }
          await reset();
        }
      });
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

  // Issue #646 — mutating endpoints return the full resource, not a stub.
  describe("PUT /api/orgs/:orgId/members/:userId", () => {
    it("returns the full member DTO (not just {userId, role})", async () => {
      const ctx = await createTestContext({ orgSlug: "roleorg" });
      const member = await createTestUser({ email: "promote@test.com" });
      await addOrgMember(ctx.orgId, member.id, "member");

      const res = await app.request(`/api/orgs/${ctx.orgId}/members/${member.id}`, {
        method: "PUT",
        headers: orgOnlyHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ role: "admin" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      // Legacy fields preserved (superset)
      expect(body.userId).toBe(member.id);
      expect(body.role).toBe("admin");
      // Full member DTO — same shape as the members list in GET /api/orgs/:orgId
      expect(body.email).toBe("promote@test.com");
      expect(body).toHaveProperty("joinedAt");
      expect(body.joinedAt).toBeTruthy();

      // Persisted
      await assertDbHas(
        organizationMembers,
        and(eq(organizationMembers.userId, member.id), eq(organizationMembers.role, "admin"))!,
      );
    });
  });

  describe("PUT /api/orgs/:orgId/invitations/:invitationId", () => {
    it("returns the full invitation DTO (not just {id, role})", async () => {
      const ctx = await createTestContext({ orgSlug: "invorg" });
      const invitation = await createInvitation({
        email: "invitee@test.com",
        orgId: ctx.orgId,
        role: "member",
        invitedBy: ctx.user.id,
        skipEmail: true,
      });

      const res = await app.request(`/api/orgs/${ctx.orgId}/invitations/${invitation.id}`, {
        method: "PUT",
        headers: orgOnlyHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ role: "admin" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      // Legacy fields preserved (superset)
      expect(body.id).toBe(invitation.id);
      expect(body.role).toBe("admin");
      // Full invitation DTO — same shape as the invitations list in GET /api/orgs/:orgId
      expect(body.email).toBe("invitee@test.com");
      expect(body.token).toBe(invitation.token);
      expect(body).toHaveProperty("expiresAt");
      expect(body).toHaveProperty("createdAt");

      // Persisted
      await assertDbHas(
        orgInvitations,
        and(eq(orgInvitations.id, invitation.id), eq(orgInvitations.role, "admin"))!,
      );
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
      const body = (await res.json()) as { data: { id: string }[] };
      const ids = body.data.map((o) => o.id);
      expect(ids).toContain(ctxA.orgId);
      expect(ids).not.toContain(orgB.id);
      expect(body.data).toHaveLength(1);
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
      const body = (await res.json()) as { data: { id: string }[] };
      const ids = body.data.map((o) => o.id);
      expect(ids).toContain(ctxA.orgId);
      expect(ids).toContain(orgB.id);
    });
  });

  describe("DELETE /api/orgs/:orgId", () => {
    it("deletes the org and persists an org.deleted audit event (issue #546)", async () => {
      const ctx = await createTestContext({ orgName: "Doomed Org", orgSlug: "doomed-org" });

      const res = await app.request(`/api/orgs/${ctx.orgId}`, {
        method: "DELETE",
        headers: { Cookie: ctx.cookie },
      });

      expect(res.status).toBe(204);

      // Org row is gone.
      const orgRows = await db.select().from(organizations).where(eq(organizations.id, ctx.orgId));
      expect(orgRows).toHaveLength(0);

      // The audit event survives the deletion: org_id is denormalized (no FK),
      // so it keeps the deleted org's id.
      const events = await db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, "org.deleted"), eq(auditEvents.resourceId, ctx.orgId)));
      expect(events).toHaveLength(1);
      const row = events[0]!;
      expect(row.orgId).toBe(ctx.orgId);
      expect(row.resourceType).toBe("org");
    });

    it("retains the org's existing audit trail after deletion (no FK cascade)", async () => {
      const ctx = await createTestContext({ orgSlug: "doomed-org-2" });

      // A pre-existing audit row for the org.
      await recordAudit({
        orgId: ctx.orgId,
        actorType: "user",
        actorId: ctx.user.id,
        action: "connection.created",
        resourceType: "connection",
        resourceId: "conn_keepme",
      });

      await app.request(`/api/orgs/${ctx.orgId}`, {
        method: "DELETE",
        headers: { Cookie: ctx.cookie },
      });

      // The historical row outlives its org instead of being cascade-wiped.
      const rows = await db.select().from(auditEvents).where(eq(auditEvents.orgId, ctx.orgId));
      const actions = rows.map((r) => r.action);
      expect(actions).toContain("connection.created");
      expect(actions).toContain("org.deleted");
    });
  });
});
