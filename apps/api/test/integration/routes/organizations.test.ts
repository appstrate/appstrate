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
import { assertDbHas, assertDbMissing } from "../../helpers/assertions.ts";
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

    // RBAC spec §6.5 — each item carries the caller's ORG-LEVEL effective set
    // in that org, so the SPA never re-derives anything from `role`.
    describe("permissions", () => {
      async function permissionsFor(
        role: "owner" | "admin" | "member" | "guest",
      ): Promise<string[]> {
        const ctx = await createTestContext({ orgSlug: `perms-${role}` });
        let cookie = ctx.cookie;
        if (role !== "owner") {
          const other = await createTestUser({ email: `perms-${role}@test.com` });
          await addOrgMember(ctx.orgId, other.id, role);
          cookie = other.cookie;
        }
        const res = await app.request("/api/orgs", { headers: { Cookie: cookie } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: { id: string; permissions: string[] }[] };
        return body.data.find((o) => o.id === ctx.orgId)!.permissions;
      }

      it("gives an owner the org-level set including org:delete", async () => {
        const perms = await permissionsFor("owner");
        expect(perms).toContain("org:delete");
        expect(perms).toContain("members:invite");
        // Space-level strings never appear on an org listing item.
        expect(perms).not.toContain("agents:read");
      });

      it("gives a member reads but not member administration", async () => {
        const perms = await permissionsFor("member");
        expect(perms).toContain("org:read");
        expect(perms).toContain("members:read");
        expect(perms).not.toContain("members:invite");
        expect(perms).not.toContain("org:delete");
      });

      it("gives a guest no view of the org directory", async () => {
        const perms = await permissionsFor("guest");
        expect(perms).toContain("org:read");
        expect(perms).toContain("spaces:read");
        expect(perms).not.toContain("members:read");
      });

      it("narrows an API key's item to the key's own scopes", async () => {
        const ctx = await createTestContext({ orgSlug: "perms-apikey" });
        const key = await seedApiKey({
          orgId: ctx.orgId,
          spaceId: ctx.defaultSpaceId,
          createdBy: ctx.user.id,
          // `agents:read` is space-level and `spaces:read` org-level: only the
          // second can survive the org half, which is what makes this
          // assertion discriminate between "ceiling applied" and "role set".
          scopes: ["agents:read", "spaces:read"],
        });

        const res = await app.request("/api/orgs", {
          headers: { Authorization: `Bearer ${key.rawKey}` },
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: { permissions: string[] }[] };
        expect(body.data).toHaveLength(1);
        expect(body.data[0]!.permissions).toEqual(["spaces:read"]);
      });
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

    it("exposes storage usage with a null limit when no quota is configured (issue #945)", async () => {
      const ctx = await createTestContext();
      // Simulate stored files by bumping the transactional byte counter.
      await db
        .update(organizations)
        .set({ filesBytesUsed: 2048 })
        .where(eq(organizations.id, ctx.orgId));

      const res = await app.request(`/api/orgs/${ctx.orgId}`, {
        headers: { Cookie: ctx.cookie },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.storage).toEqual({
        used_bytes: 2048,
        limit_bytes: null,
        effective_limit_bytes: null,
      });
    });

    it("surfaces a per-org limit override as both limit_bytes and effective_limit_bytes", async () => {
      const ctx = await createTestContext();
      await db
        .update(organizations)
        .set({ filesBytesUsed: 100, filesBytesLimit: 4096 })
        .where(eq(organizations.id, ctx.orgId));

      const res = await app.request(`/api/orgs/${ctx.orgId}`, {
        headers: { Cookie: ctx.cookie },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      // Override wins over any env quota; both fields report it (no env quota set here).
      expect(body.storage).toEqual({
        used_bytes: 100,
        limit_bytes: 4096,
        effective_limit_bytes: 4096,
      });
    });

    it("reports the env quota as effective_limit_bytes (override unset) when ORG_STORAGE_QUOTA_BYTES is set (issue #945)", async () => {
      const ctx = await createTestContext();
      await db
        .update(organizations)
        .set({ filesBytesUsed: 500 })
        .where(eq(organizations.id, ctx.orgId));

      const snapshot = process.env.ORG_STORAGE_QUOTA_BYTES;
      const { _resetCacheForTesting } = await import("@appstrate/env");
      process.env.ORG_STORAGE_QUOTA_BYTES = "10000";
      _resetCacheForTesting();
      try {
        const res = await app.request(`/api/orgs/${ctx.orgId}`, {
          headers: { Cookie: ctx.cookie },
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        // No per-org override → limit_bytes null; the env quota is the effective limit.
        expect(body.storage).toEqual({
          used_bytes: 500,
          limit_bytes: null,
          effective_limit_bytes: 10000,
        });
      } finally {
        if (snapshot === undefined) delete process.env.ORG_STORAGE_QUOTA_BYTES;
        else process.env.ORG_STORAGE_QUOTA_BYTES = snapshot;
        _resetCacheForTesting();
      }
    });
  });

  describe("PUT /api/orgs/:orgId", () => {
    it("returns the bare OrgDetail (same serializer as GET /api/orgs/:orgId)", async () => {
      const ctx = await createTestContext({ orgSlug: "renameorg" });

      const res = await app.request(`/api/orgs/${ctx.orgId}`, {
        method: "PUT",
        headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed Org" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe(ctx.orgId);
      expect(body.name).toBe("Renamed Org");
      expect(body.members).toBeArray();
      expect(body.members).toHaveLength(1);
      expect(body.invitations).toBeArray();
      // No serializer drift: the divergent pre-#657 shape is gone.
      expect(body).not.toHaveProperty("created_by");
      expect(body).not.toHaveProperty("updatedAt");
    });

    it("403s an admin — renaming the org is owner-only (org:update)", async () => {
      // The route reads `org:update` from the matrix now; before Phase 1 it
      // compared the role name. `admin` therefore must NOT hold `org:update`,
      // or the conversion would have widened who can re-slug the org.
      const ctx = await createTestContext({ orgSlug: "ownerorg" });
      const admin = await createTestUser();
      await addOrgMember(ctx.orgId, admin.id, "admin");

      const res = await app.request(`/api/orgs/${ctx.orgId}`, {
        method: "PUT",
        headers: { Cookie: admin.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Admin Rename" }),
      });
      expect(res.status).toBe(403);

      // Discriminating control: the same admin CAN write the settings, so the
      // 403 is about `org:update`, not about admins being locked out of the
      // org routes wholesale.
      const settings = await app.request(`/api/orgs/${ctx.orgId}/settings`, {
        method: "PUT",
        headers: { Cookie: admin.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ dashboard_sso_enabled: true }),
      });
      expect(settings.status).toBe(200);
    });

    it("200s the owner on the same request", async () => {
      const ctx = await createTestContext({ orgSlug: "ownerok" });
      const res = await app.request(`/api/orgs/${ctx.orgId}`, {
        method: "PUT",
        headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Owner Rename" }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("PUT /api/orgs/:orgId/settings — api_version", () => {
    // `apiVersion` middleware is mounted on `*` and 400s on a pin it cannot
    // serve, so an unsupported value persisted here would lock the org out of
    // every authed route — including this one. The write path must make that
    // state unreachable.

    it("rejects a well-formed but unsupported api_version and leaves settings untouched", async () => {
      const ctx = await createTestContext();
      const before = await getOrgSettings(ctx.orgId);

      const res = await app.request(`/api/orgs/${ctx.orgId}/settings`, {
        method: "PUT",
        headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ api_version: "2020-01-01" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; param: string };
      expect(body.code).toBe("unsupported_api_version");
      expect(body.param).toBe("api_version");

      // The stored row, not just the response: a 400 that still wrote would
      // brick the org exactly the same way.
      expect(await getOrgSettings(ctx.orgId)).toEqual(before);
    });

    it("rejects a malformed api_version and leaves settings untouched", async () => {
      const ctx = await createTestContext();
      const before = await getOrgSettings(ctx.orgId);

      const res = await app.request(`/api/orgs/${ctx.orgId}/settings`, {
        method: "PUT",
        headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ api_version: "not-a-date" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; param: string };
      expect(body.code).toBe("unsupported_api_version");
      expect(body.param).toBe("api_version");

      expect(await getOrgSettings(ctx.orgId)).toEqual(before);
    });

    it("does not discard the other settings fields sent alongside a bad api_version", async () => {
      // The whole body is rejected — a partial write would leave the caller
      // guessing which half landed.
      const ctx = await createTestContext();

      const res = await app.request(`/api/orgs/${ctx.orgId}/settings`, {
        method: "PUT",
        headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ api_version: "2020-01-01", dashboard_sso_enabled: true }),
      });

      expect(res.status).toBe(400);
      const settings = await getOrgSettings(ctx.orgId);
      expect(settings.dashboard_sso_enabled).not.toBe(true);
    });

    it("accepts a supported api_version", async () => {
      const ctx = await createTestContext();

      const res = await app.request(`/api/orgs/${ctx.orgId}/settings`, {
        method: "PUT",
        headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ api_version: CURRENT_API_VERSION }),
      });

      expect(res.status).toBe(200);
      const settings = await getOrgSettings(ctx.orgId);
      expect(settings.api_version).toBe(CURRENT_API_VERSION);
    });

    it("leaves the org fully usable after a rejected write (self-brick regression)", async () => {
      // The test that actually pins the fix: before the write-path guard, the
      // rejected value above would have been persisted and every subsequent
      // request — including the PUT needed to undo it — would 400.
      const ctx = await createTestContext();

      // Pin the org first, so the middleware's org-pin branch is actually
      // exercised below rather than the no-pin fallback.
      const pin = await app.request(`/api/orgs/${ctx.orgId}/settings`, {
        method: "PUT",
        headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ api_version: CURRENT_API_VERSION }),
      });
      expect(pin.status).toBe(200);

      const bad = await app.request(`/api/orgs/${ctx.orgId}/settings`, {
        method: "PUT",
        headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ api_version: "2020-01-01" }),
      });
      expect(bad.status).toBe(400);

      // A plain read on an unrelated route still resolves a serveable version.
      const list = await app.request("/api/orgs", { headers: { Cookie: ctx.cookie } });
      expect(list.status).toBe(200);
      expect(list.headers.get("Appstrate-Version")).toBe(CURRENT_API_VERSION);

      // And the settings route itself is still reachable — the recovery path.
      const recover = await app.request(`/api/orgs/${ctx.orgId}/settings`, {
        method: "PUT",
        headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ dashboard_sso_enabled: true }),
      });
      expect(recover.status).toBe(200);
    });

    // What the write guard is actually FOR. The two auth methods do not fail
    // the same way once an unserveable pin is stored, and only one of them can
    // dig itself out. These plant the pin directly in the DB (the guard makes
    // it unreachable over HTTP) to reproduce the state a pre-guard write left
    // behind.
    describe("with an unserveable pin already stored", () => {
      async function pinDirectly(orgId: string, version: string) {
        await db
          .update(organizations)
          .set({ orgSettings: { api_version: version } })
          .where(eq(organizations.id, orgId));
      }

      it("session callers keep the recovery route: /api/orgs/ skips org context", async () => {
        const ctx = await createTestContext();
        await pinDirectly(ctx.orgId, "2020-01-01");

        // Org-scoped route: the pin branch runs, so this 400s.
        const runs = await app.request("/api/runs", {
          headers: {
            Cookie: ctx.cookie,
            "X-Org-Id": ctx.orgId,
            "X-Space-Id": ctx.defaultSpaceId,
          },
        });
        expect(runs.status).toBe(400);
        expect(((await runs.json()) as { code: string }).code).toBe("unsupported_api_version");

        // The settings route does NOT: `skipOrgContext()` returns true for
        // `/api/orgs/`, so `requireOrgContext` never runs, `c.get("orgId")` is
        // unset, and the middleware skips the pin branch entirely.
        const recover = await app.request(`/api/orgs/${ctx.orgId}/settings`, {
          method: "PUT",
          headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ api_version: CURRENT_API_VERSION }),
        });
        expect(recover.status).toBe(200);
        expect((await getOrgSettings(ctx.orgId)).api_version).toBe(CURRENT_API_VERSION);
      });

      it("API-key callers are locked out — including the recovery route", async () => {
        const ctx = await createTestContext();
        const key = await seedApiKey({
          orgId: ctx.orgId,
          spaceId: ctx.defaultSpaceId,
          createdBy: ctx.user.id,
          name: "pin-lockout-key",
        });
        await pinDirectly(ctx.orgId, "2020-01-01");

        // `applyAuthPipeline` sets `orgId` inline from the key, before any
        // path-based skip — so the pin branch runs on EVERY route, this one
        // included. A headless operator has no self-serve remedy, which is
        // exactly why the write path must refuse to create this state.
        const recover = await app.request(`/api/orgs/${ctx.orgId}/settings`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${key.rawKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ api_version: CURRENT_API_VERSION }),
        });
        expect(recover.status).toBe(400);
        expect(((await recover.json()) as { code: string }).code).toBe("unsupported_api_version");
        // Still pinned — the write never landed.
        expect((await getOrgSettings(ctx.orgId)).api_version).toBe("2020-01-01");
      });
    });
  });

  describe("POST /api/orgs/:orgId/members", () => {
    it("creates an invitation even for an existing user (no silent direct-add)", async () => {
      const ctx = await createTestContext({ orgSlug: "memberorg" });
      const member = await createTestUser({ email: "member@test.com" });

      const res = await app.request(`/api/orgs/${ctx.orgId}/members`, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ email: "member@test.com", role: "member" }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      // Always a bare invitation — never a direct member add (the invitee
      // must accept first, so consent is explicit).
      expect(body.id).toBeTruthy();
      expect(body.token).toBeTruthy();
      expect(body.email).toBe("member@test.com");
      expect(body.role).toBe("member");
      expect(body).not.toHaveProperty("userId");

      // The invitation exists; no membership has been created yet.
      await assertDbHas(orgInvitations, eq(orgInvitations.email, "member@test.com"));
      await assertDbMissing(organizationMembers, eq(organizationMembers.userId, member.id));
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
      // Bare created invitation — same shape as the invitations list in
      // GET /api/orgs/:orgId (token included: endpoint is admin-gated)
      expect(body.id).toBeTruthy();
      expect(body.email).toBe("newuser@test.com");
      expect(body.role).toBe("admin");
      expect(body.token).toBeTruthy();
      expect(body.expiresAt).toBeTruthy();
      expect(body.createdAt).toBeTruthy();
      // No operation scraps
      expect(body).not.toHaveProperty("invited");
      expect(body).not.toHaveProperty("added");

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

    it("creates an invitation even when the email already belongs to a member", async () => {
      const ctx = await createTestContext({ orgSlug: "memberorg" });
      const member = await createTestUser({ email: "already@test.com" });
      await addOrgMember(ctx.orgId, member.id, "member");

      const res = await app.request(`/api/orgs/${ctx.orgId}/members`, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ email: "already@test.com" }),
      });

      // Re-inviting an existing member just creates a fresh pending invitation.
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.token).toBeTruthy();
    });
  });

  // Issue #657 — mutations return the bare full resource, not a stub.
  describe("PUT /api/orgs/:orgId/members/:userId", () => {
    it("lets an admin promote a member to admin", async () => {
      const ctx = await createTestContext({ orgSlug: "admin-role-org" });
      const admin = await createTestUser({ email: "admin-role@test.com" });
      const member = await createTestUser({ email: "member-role@test.com" });
      await addOrgMember(ctx.orgId, admin.id, "admin");
      await addOrgMember(ctx.orgId, member.id, "member");

      const res = await app.request(`/api/orgs/${ctx.orgId}/members/${member.id}`, {
        method: "PUT",
        headers: { Cookie: admin.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { role: string };
      expect(body.role).toBe("admin");
    });

    it("does not let an admin change a peer admin's role", async () => {
      const ctx = await createTestContext({ orgSlug: "peer-admin-role-org" });
      const actor = await createTestUser({ email: "actor-admin@test.com" });
      const target = await createTestUser({ email: "target-admin@test.com" });
      await addOrgMember(ctx.orgId, actor.id, "admin");
      await addOrgMember(ctx.orgId, target.id, "admin");

      const res = await app.request(`/api/orgs/${ctx.orgId}/members/${target.id}`, {
        method: "PUT",
        headers: { Cookie: actor.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "member" }),
      });

      expect(res.status).toBe(403);

      const detailRes = await app.request(`/api/orgs/${ctx.orgId}`, {
        headers: { Cookie: ctx.cookie },
      });
      const detail = (await detailRes.json()) as { members: { userId: string; role: string }[] };
      expect(detail.members.find((member) => member.userId === target.id)?.role).toBe("admin");
    });

    it("returns the bare member DTO (same shape as the members list)", async () => {
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
      // Bare member DTO — same shape as the members list in GET /api/orgs/:orgId
      expect(body.userId).toBe(member.id);
      expect(body.role).toBe("admin");
      expect(body.email).toBe("promote@test.com");
      expect(body.joinedAt).toBeTruthy();
      expect(Object.keys(body).sort()).toEqual([
        "displayName",
        "email",
        "joinedAt",
        "role",
        "userId",
      ]);

      // Persisted
      await assertDbHas(
        organizationMembers,
        and(eq(organizationMembers.userId, member.id), eq(organizationMembers.role, "admin"))!,
      );
    });
  });

  describe("PUT /api/orgs/:orgId/invitations/:invitationId", () => {
    it("lets an admin change a pending invitation's role", async () => {
      const ctx = await createTestContext({ orgSlug: "admin-invitation-role-org" });
      const admin = await createTestUser({ email: "invitation-admin@test.com" });
      await addOrgMember(ctx.orgId, admin.id, "admin");
      const invitation = await createInvitation({
        email: "admin-invitee@test.com",
        orgId: ctx.orgId,
        role: "member",
        invitedBy: ctx.user.id,
        spaceAssignments: [],
      });

      const res = await app.request(`/api/orgs/${ctx.orgId}/invitations/${invitation.id}`, {
        method: "PUT",
        headers: { Cookie: admin.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { role: string };
      expect(body.role).toBe("admin");
    });

    it("returns the bare invitation DTO (same shape as the invitations list)", async () => {
      const ctx = await createTestContext({ orgSlug: "invorg" });
      const invitation = await createInvitation({
        email: "invitee@test.com",
        orgId: ctx.orgId,
        role: "member",
        invitedBy: ctx.user.id,
        spaceAssignments: [],
      });

      const res = await app.request(`/api/orgs/${ctx.orgId}/invitations/${invitation.id}`, {
        method: "PUT",
        headers: orgOnlyHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ role: "admin" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      // Bare invitation DTO — same shape as the invitations list in
      // GET /api/orgs/:orgId (token kept in the full invitation DTO)
      expect(body.id).toBe(invitation.id);
      expect(body.role).toBe("admin");
      expect(body.email).toBe("invitee@test.com");
      expect(body.token).toBe(invitation.token);
      expect(Object.keys(body).sort()).toEqual([
        "createdAt",
        "email",
        "expiresAt",
        "id",
        "role",
        "space_assignments",
        "token",
      ]);

      // Persisted
      await assertDbHas(
        orgInvitations,
        and(eq(orgInvitations.id, invitation.id), eq(orgInvitations.role, "admin"))!,
      );
    });
  });

  describe("DELETE /api/orgs/:orgId/members/:userId", () => {
    it("lets an admin remove a regular member", async () => {
      const ctx = await createTestContext({ orgSlug: "admin-remove-member-org" });
      const admin = await createTestUser({ email: "remove-member-admin@test.com" });
      const member = await createTestUser({ email: "remove-member@test.com" });
      await addOrgMember(ctx.orgId, admin.id, "admin");
      await addOrgMember(ctx.orgId, member.id, "member");

      const res = await app.request(`/api/orgs/${ctx.orgId}/members/${member.id}`, {
        method: "DELETE",
        headers: { Cookie: admin.cookie },
      });

      expect(res.status).toBe(204);
    });

    it("does not let an admin remove a peer admin", async () => {
      const ctx = await createTestContext({ orgSlug: "remove-peer-admin-org" });
      const actor = await createTestUser({ email: "remove-actor@test.com" });
      const target = await createTestUser({ email: "remove-target@test.com" });
      await addOrgMember(ctx.orgId, actor.id, "admin");
      await addOrgMember(ctx.orgId, target.id, "admin");

      const res = await app.request(`/api/orgs/${ctx.orgId}/members/${target.id}`, {
        method: "DELETE",
        headers: { Cookie: actor.cookie },
      });

      expect(res.status).toBe(403);

      const detailRes = await app.request(`/api/orgs/${ctx.orgId}`, {
        headers: { Cookie: ctx.cookie },
      });
      const detail = (await detailRes.json()) as { members: { userId: string }[] };
      expect(detail.members.some((member) => member.userId === target.id)).toBe(true);
    });

    it("removes the member and returns 204 with an empty body", async () => {
      const ctx = await createTestContext({ orgSlug: "delmemorg" });
      const member = await createTestUser({ email: "leaver@test.com" });
      await addOrgMember(ctx.orgId, member.id, "member");

      const res = await app.request(`/api/orgs/${ctx.orgId}/members/${member.id}`, {
        method: "DELETE",
        headers: orgOnlyHeaders(ctx),
      });

      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");

      const rows = await db
        .select()
        .from(organizationMembers)
        .where(
          and(eq(organizationMembers.userId, member.id), eq(organizationMembers.orgId, ctx.orgId)),
        );
      expect(rows).toHaveLength(0);
    });
  });

  describe("DELETE /api/orgs/:orgId/invitations/:invitationId", () => {
    it("revokes the invitation and returns 204 with an empty body", async () => {
      const ctx = await createTestContext({ orgSlug: "delinvorg" });
      const invitation = await createInvitation({
        email: "revoked@test.com",
        orgId: ctx.orgId,
        role: "member",
        invitedBy: ctx.user.id,
        spaceAssignments: [],
      });

      const res = await app.request(`/api/orgs/${ctx.orgId}/invitations/${invitation.id}`, {
        method: "DELETE",
        headers: orgOnlyHeaders(ctx),
      });

      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");

      // Soft-cancel: the row is kept with status flipped to "cancelled".
      const [row] = await db
        .select()
        .from(orgInvitations)
        .where(eq(orgInvitations.id, invitation.id));
      expect(row!.status).toBe("cancelled");
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
        spaceId: ctxA.defaultSpaceId,
        createdBy: ctxA.user.id,
        scopes: ["agents:read", "spaces:read", "spaces:write", "spaces:delete"],
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

  // ── CRIT-02 — API keys must not reach org administration ─────────────────
  //
  // Org administration is org-level and session-only: `org:*` and `members:*`
  // are absent from the API-key scope allowlist, so a key never holds them —
  // whatever its creator's role, and whatever scopes it carries (`runs:read`
  // here).
  //
  // Unlike the issue-#172 suite above (foreign org → apiKeyOrgScopeGuard),
  // these requests target the key's OWN org: drop the session-only rule and
  // the creator's owner standing flows straight into the key, so every gated
  // request below succeeds — each 403 assertion here fails.
  describe("API keys cannot administer their OWN org (CRIT-02)", () => {
    async function setupOwnerKeyInOwnOrg() {
      const ctx = await createTestContext({ orgSlug: "crit02-org" });
      // A second, removable member — the target of remove/change-role.
      const member = await createTestUser();
      await addOrgMember(ctx.orgId, member.id, "member");
      const apiKey = await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id, // creator is the org OWNER
        scopes: ["runs:read"], // narrow scope — must NOT inherit owner rights
      });
      return {
        ctx,
        member,
        bearer: { Authorization: `Bearer ${apiKey.rawKey}` },
      };
    }

    it("PUT /api/orgs/:keyOrgId with an owner-created API key → 403, org not renamed", async () => {
      const { ctx, bearer } = await setupOwnerKeyInOwnOrg();

      const res = await app.request(`/api/orgs/${ctx.orgId}`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "PWNED-BY-KEY" }),
      });

      expect(res.status).toBe(403);
      const [row] = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, ctx.orgId));
      expect(row?.name).not.toBe("PWNED-BY-KEY");
    });

    it("DELETE /api/orgs/:keyOrgId with an owner-created API key → 403, org survives", async () => {
      const { ctx, bearer } = await setupOwnerKeyInOwnOrg();

      const res = await app.request(`/api/orgs/${ctx.orgId}`, {
        method: "DELETE",
        headers: bearer,
      });

      expect(res.status).toBe(403);
      await assertDbHas(organizations, eq(organizations.id, ctx.orgId));
    });

    it("DELETE /api/orgs/:keyOrgId/members/:userId → 403, membership survives", async () => {
      const { ctx, member, bearer } = await setupOwnerKeyInOwnOrg();

      const res = await app.request(`/api/orgs/${ctx.orgId}/members/${member.id}`, {
        method: "DELETE",
        headers: bearer,
      });

      expect(res.status).toBe(403);
      await assertDbHas(
        organizationMembers,
        and(eq(organizationMembers.orgId, ctx.orgId), eq(organizationMembers.userId, member.id))!,
      );
    });

    it("PUT /api/orgs/:keyOrgId/members/:userId → 403, role unchanged", async () => {
      const { ctx, member, bearer } = await setupOwnerKeyInOwnOrg();

      const res = await app.request(`/api/orgs/${ctx.orgId}/members/${member.id}`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      });

      expect(res.status).toBe(403);
      const [row] = await db
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(
          and(eq(organizationMembers.orgId, ctx.orgId), eq(organizationMembers.userId, member.id)),
        );
      expect(row?.role).toBe("member");
    });

    it("PUT /api/orgs/:keyOrgId/settings → 403, settings unchanged", async () => {
      const { ctx, bearer } = await setupOwnerKeyInOwnOrg();

      const res = await app.request(`/api/orgs/${ctx.orgId}/settings`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ dashboard_sso_enabled: true }),
      });

      expect(res.status).toBe(403);
      const settings = await getOrgSettings(ctx.orgId);
      expect(settings.dashboard_sso_enabled).not.toBe(true);
    });

    it("the owner's COOKIE SESSION still performs every gated operation (feature intact)", async () => {
      // The regression that proves the fix rejects the auth METHOD, not the
      // operations themselves: the same human owner over a cookie session
      // must keep full org administration.
      const { ctx, member } = await setupOwnerKeyInOwnOrg();
      const cookieHeaders = { Cookie: ctx.cookie, "Content-Type": "application/json" };

      const rename = await app.request(`/api/orgs/${ctx.orgId}`, {
        method: "PUT",
        headers: cookieHeaders,
        body: JSON.stringify({ name: "Renamed By Owner" }),
      });
      expect(rename.status).toBe(200);

      const settings = await app.request(`/api/orgs/${ctx.orgId}/settings`, {
        method: "PUT",
        headers: cookieHeaders,
        body: JSON.stringify({ dashboard_sso_enabled: true }),
      });
      expect(settings.status).toBe(200);

      const roleChange = await app.request(`/api/orgs/${ctx.orgId}/members/${member.id}`, {
        method: "PUT",
        headers: cookieHeaders,
        body: JSON.stringify({ role: "admin" }),
      });
      expect(roleChange.status).toBe(200);

      const removal = await app.request(`/api/orgs/${ctx.orgId}/members/${member.id}`, {
        method: "DELETE",
        headers: { Cookie: ctx.cookie },
      });
      expect(removal.status).toBe(204);
      await assertDbMissing(
        organizationMembers,
        and(eq(organizationMembers.orgId, ctx.orgId), eq(organizationMembers.userId, member.id))!,
      );

      const deletion = await app.request(`/api/orgs/${ctx.orgId}`, {
        method: "DELETE",
        headers: { Cookie: ctx.cookie },
      });
      expect(deletion.status).toBe(204);
      await assertDbMissing(organizations, eq(organizations.id, ctx.orgId));
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
