// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "bun:test";
import type { AppstrateModule } from "@appstrate/core/module";
import { and, eq } from "drizzle-orm";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedApiKey, seedPackage, seedSchedule } from "../../helpers/seed.ts";
import { describeRequiresPostgres } from "../../helpers/tier.ts";
import {
  apiKeys,
  oauthAccessToken,
  oauthClient,
  oauthRefreshToken,
  organizationMembers,
  organizations,
  schedules,
} from "@appstrate/db/schema";
import {
  createOrganization,
  getUserOrganizations,
  getOrgMembers,
  isSlugAvailable,
  getOrgById,
  provisionMember,
  removeMember,
  leaveOrganization,
  updateMemberRole,
  getOrgSettings,
  getCachedOrgApiVersion,
  updateOrgSettings,
  listOrgsWithUnsupportedApiVersion,
  orgSettingsPatchSchema,
} from "../../../src/services/organizations.ts";
import { setCacheClock } from "@appstrate/core/cache";
import { orgSettingsSchema } from "@appstrate/core/permissions";
import { toSlug } from "@appstrate/core/naming";
import { CURRENT_API_VERSION, listSupportedVersions } from "../../../src/lib/api-versions.ts";
import { ApiError } from "../../../src/lib/errors.ts";
import { getMcpOrgResourceUri } from "../../../src/lib/audiences.ts";
import { loadModulesFromInstances, resetModules } from "../../../src/lib/modules/module-loader.ts";
import { buildModuleInitContext } from "../../../src/lib/modules/registry.ts";
import { restoreDiscoveredModules } from "../../helpers/test-modules.ts";
import { getTestApp } from "../../helpers/app.ts";

/** Owner ids of `orgId`, read straight from the table. */
async function ownerIds(orgId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, "owner")));
  return rows.map((row) => row.userId);
}

const slugify = (v: string) => toSlug(v, 50);

describe("organizations service", () => {
  let userId: string;

  beforeEach(async () => {
    await truncateAll();
    const { cookie: _cookie, ...user } = await createTestUser();
    userId = user.id;
  });

  // ── createOrganization ────────────────────────────────────

  describe("createOrganization", () => {
    it("creates an organization and adds the user as owner", async () => {
      const org = await createOrganization("My Org", "my-org", userId);

      expect(org.id).toBeDefined();
      expect(org.name).toBe("My Org");
      expect(org.slug).toBe("my-org");
      expect(org.createdBy).toBe(userId);
    });

    it("the creator is listed as owner in members", async () => {
      const org = await createOrganization("Owner Org", "owner-org", userId);

      const members = await getOrgMembers(org.id);
      expect(members).toHaveLength(1);
      expect(members[0]!.userId).toBe(userId);
      expect(members[0]!.role).toBe("owner");
    });

    it("returns valid ISO timestamps", async () => {
      const org = await createOrganization("TS Org", "ts-org", userId);

      expect(org.createdAt).toBeTruthy();
      expect(org.updatedAt).toBeTruthy();
      // Validate they are parseable ISO strings
      expect(new Date(org.createdAt).getTime()).not.toBeNaN();
      expect(new Date(org.updatedAt).getTime()).not.toBeNaN();
    });

    it("can be retrieved by ID after creation", async () => {
      const org = await createOrganization("Fetch Org", "fetch-org", userId);

      const fetched = await getOrgById(org.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.slug).toBe("fetch-org");
    });

    it("pins apiVersion to CURRENT_API_VERSION at creation", async () => {
      const org = await createOrganization("Versioned Org", "versioned-org", userId);

      const settings = await getOrgSettings(org.id);
      expect(settings.api_version).toBe(CURRENT_API_VERSION);
    });
  });

  // ── org settings: which schema actually guards the shape ──
  //
  // The rationale on `orgSettingsPatchSchema` claims the base schema in
  // `@appstrate/core/permissions` is never a parser, so all the closure lives
  // on the patch schema. Both halves are asserted here, because a future
  // reader who believes the base is a read-path validator will reach for the
  // wrong lever.
  describe("org settings schema boundary", () => {
    it("the base schema STRIPS unknown keys — it never tolerates them", () => {
      const parsed = orgSettingsSchema.safeParse({ api_version: "2026-01-01", future_key: 1 });

      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual({ api_version: "2026-01-01" });
      expect(parsed.data).not.toHaveProperty("future_key");
    });

    it("the patch schema is the one that refuses an unknown key", () => {
      expect(orgSettingsPatchSchema.safeParse({ dashboard_sso_enabled: true }).success).toBe(true);
      expect(orgSettingsPatchSchema.safeParse({ future_key: 1 }).success).toBe(false);
    });

    it("getOrgSettings casts the stored row — it does not parse it", async () => {
      const org = await createOrganization("Cast Org", "cast-org", userId);
      await db
        .update(organizations)
        .set({ orgSettings: { api_version: CURRENT_API_VERSION, future_key: "kept" } })
        .where(eq(organizations.id, org.id));

      // A key no schema declares survives the read verbatim. If this ever
      // starts failing, a parse was introduced on the read path and the
      // rationale on `orgSettingsPatchSchema` needs revisiting.
      expect(await getOrgSettings(org.id)).toEqual({
        api_version: CURRENT_API_VERSION,
        future_key: "kept",
      } as never);
    });
  });

  // ── getCachedOrgApiVersion ────────────────────────────────

  // The api-version middleware resolves the `api_version` pin on every
  // strategy-authenticated request (chat `chatloop_` hops, API keys), so the
  // pin — and ONLY the pin — reads through a 10 s per-org cache
  // (`services/org-settings-cache.ts`). `getOrgSettings` itself stays
  // uncached (the oidc SSO gate depends on it reading fresh). These pin the
  // three properties that make the pin cache safe to rely on: a repeated read
  // is served from memory, a service-layer write is visible immediately, and
  // the TTL is the backstop for writes that bypass the service layer.
  describe("getCachedOrgApiVersion", () => {
    let clock: number;

    beforeEach(() => {
      clock = Date.now();
      setCacheClock(() => clock);
    });

    afterEach(() => {
      setCacheClock(null);
    });

    it("serves a repeated read from memory — a direct pin update is NOT seen until the TTL", async () => {
      const org = await createOrganization("Cached Org", "cached-org", userId);
      expect(await getCachedOrgApiVersion(org.id)).toBe(CURRENT_API_VERSION);

      // Write the row directly, bypassing the service writer (so nothing
      // invalidates). Negative control: without the cache the next read
      // would return "2020-01-01" and this assertion would fail.
      await db
        .update(organizations)
        .set({ orgSettings: { api_version: "2020-01-01" } })
        .where(eq(organizations.id, org.id));
      expect(await getCachedOrgApiVersion(org.id)).toBe(CURRENT_API_VERSION);
      // The uncached reader sees the row as it is — it is not behind the cache.
      expect((await getOrgSettings(org.id)).api_version).toBe("2020-01-01");

      // Past the TTL the entry expires and the direct write becomes visible.
      clock += 10_001;
      expect(await getCachedOrgApiVersion(org.id)).toBe("2020-01-01");
    });

    it("updateOrgSettings invalidates — the next cached read sees the fresh row immediately", async () => {
      const org = await createOrganization("Fresh Org", "fresh-org", userId);
      // Prime the cache with the creation-time pin, then plant a different pin
      // directly so the cached and stored values disagree.
      expect(await getCachedOrgApiVersion(org.id)).toBe(CURRENT_API_VERSION);
      await db
        .update(organizations)
        .set({ orgSettings: { api_version: "2020-01-01" } })
        .where(eq(organizations.id, org.id));
      expect(await getCachedOrgApiVersion(org.id)).toBe(CURRENT_API_VERSION);

      // A service-layer write to ANY settings key busts the pin entry: same
      // clock tick, well inside the TTL — only the invalidation explains
      // seeing the stored pin here.
      await updateOrgSettings(org.id, { dashboard_sso_enabled: true });
      expect(await getCachedOrgApiVersion(org.id)).toBe("2020-01-01");
    });

    it("caches an unpinned org as null — the null is a hit, not a re-query per read", async () => {
      const org = await createOrganization("Unpinned Org", "unpinned-org", userId);
      await db
        .update(organizations)
        .set({ orgSettings: { dashboard_sso_enabled: true } })
        .where(eq(organizations.id, org.id));
      expect(await getCachedOrgApiVersion(org.id)).toBeNull();

      // A direct pin write after the null was cached is NOT seen — proving
      // the null itself is a cached value.
      await db
        .update(organizations)
        .set({ orgSettings: { api_version: "2020-01-01" } })
        .where(eq(organizations.id, org.id));
      expect(await getCachedOrgApiVersion(org.id)).toBeNull();
    });

    it("entries are per org — one org's cached pin does not shadow another's", async () => {
      const a = await createOrganization("Org A", "org-a", userId);
      const b = await createOrganization("Org B", "org-b", userId);
      expect(await getCachedOrgApiVersion(a.id)).toBe(CURRENT_API_VERSION);

      await db
        .update(organizations)
        .set({ orgSettings: { api_version: "2020-01-01" } })
        .where(eq(organizations.id, b.id));
      expect(await getCachedOrgApiVersion(b.id)).toBe("2020-01-01");
      expect(await getCachedOrgApiVersion(a.id)).toBe(CURRENT_API_VERSION);
    });
  });

  // ── listOrgsWithUnsupportedApiVersion ─────────────────────

  // Powers the boot-time diagnostic (`lib/boot.ts`). An org holding a pin this
  // build cannot serve 400s on every org-scoped route with no other signal, so
  // this query is the only thing that turns that into a startup log line.
  describe("listOrgsWithUnsupportedApiVersion", () => {
    const supported = listSupportedVersions();

    async function setPin(orgId: string, orgSettings: Record<string, unknown>) {
      await db.update(organizations).set({ orgSettings }).where(eq(organizations.id, orgId));
    }

    it("is silent when every org is pinned to a supported version", async () => {
      await createOrganization("Healthy", "healthy-pin", userId);

      expect(await listOrgsWithUnsupportedApiVersion(supported)).toEqual([]);
    });

    it("reports orgs pinned to a version that was dropped, with the offending value", async () => {
      const org = await createOrganization("Stale", "stale-pin", userId);
      await setPin(org.id, { api_version: "2020-01-01" });

      const rows = await listOrgsWithUnsupportedApiVersion(supported);

      expect(rows).toEqual([{ id: org.id, apiVersion: "2020-01-01" }]);
    });

    it("reports a malformed pin too — the middleware rejects it identically", async () => {
      const org = await createOrganization("Garbage", "garbage-pin", userId);
      await setPin(org.id, { api_version: "not-a-date" });

      const rows = await listOrgsWithUnsupportedApiVersion(supported);

      expect(rows.map((r) => r.apiVersion)).toEqual(["not-a-date"]);
    });

    it("ignores orgs with no pin at all — absence falls back, it does not fail", async () => {
      const org = await createOrganization("Unpinned", "unpinned", userId);
      await setPin(org.id, { dashboard_sso_enabled: true });

      expect(await listOrgsWithUnsupportedApiVersion(supported)).toEqual([]);
    });

    it("separates healthy orgs from unserveable ones in a mixed table", async () => {
      const healthy = await createOrganization("Mixed OK", "mixed-ok", userId);
      const broken = await createOrganization("Mixed Bad", "mixed-bad", userId);
      await setPin(broken.id, { api_version: "1999-12-31" });

      const rows = await listOrgsWithUnsupportedApiVersion(supported);

      expect(rows.map((r) => r.id)).toEqual([broken.id]);
      expect(rows.map((r) => r.id)).not.toContain(healthy.id);
    });
  });

  // ── getUserOrganizations ──────────────────────────────────

  describe("getUserOrganizations", () => {
    it("returns all organizations the user belongs to", async () => {
      await createOrganization("Org A", "org-a", userId);
      await createOrganization("Org B", "org-b", userId);

      const orgs = await getUserOrganizations(userId);

      expect(orgs).toHaveLength(2);
      const slugs = orgs.map((o) => o.slug);
      expect(slugs).toContain("org-a");
      expect(slugs).toContain("org-b");
    });

    it("includes the user role in each organization", async () => {
      await createOrganization("Role Org", "role-org", userId);

      const orgs = await getUserOrganizations(userId);
      expect(orgs[0]!.role).toBe("owner");
    });

    it("returns an empty array for a user with no organizations", async () => {
      const lonelyUser = await createTestUser({ email: "lonely@test.com" });

      const orgs = await getUserOrganizations(lonelyUser.id);
      expect(orgs).toHaveLength(0);
    });

    it("returns orgs where user is a member added later", async () => {
      const org = await createOrganization("Join Org", "join-org", userId);
      const newUser = await createTestUser({ email: "joiner@test.com" });

      await db.transaction((tx) => provisionMember(tx, org.id, newUser.id, "member"));

      const orgs = await getUserOrganizations(newUser.id);
      expect(orgs).toHaveLength(1);
      expect(orgs[0]!.slug).toBe("join-org");
      expect(orgs[0]!.role).toBe("member");
    });
  });

  // ── getOrgMembers ─────────────────────────────────────────

  describe("getOrgMembers", () => {
    it("lists all members of an organization", async () => {
      const org = await createOrganization("Members Org", "members-org", userId);
      const member = await createTestUser({ email: "member@test.com" });
      await db.transaction((tx) => provisionMember(tx, org.id, member.id, "member"));

      const members = await getOrgMembers(org.id);

      expect(members).toHaveLength(2);
      const roles = members.map((m) => m.role);
      expect(roles).toContain("owner");
      expect(roles).toContain("member");
    });

    it("includes email and displayName when available", async () => {
      const org = await createOrganization("Info Org", "info-org", userId);

      const members = await getOrgMembers(org.id);
      expect(members).toHaveLength(1);
      // Email should be populated from the user table
      expect(members[0]!.email).toBeDefined();
      expect(typeof members[0]!.email).toBe("string");
    });

    it("returns an empty array for an org with no members (edge case)", async () => {
      // This would be unusual but the service should handle it
      const members = await getOrgMembers("00000000-0000-0000-0000-000000000000");
      expect(members).toHaveLength(0);
    });
  });

  // ── isSlugAvailable ───────────────────────────────────────

  describe("isSlugAvailable", () => {
    it("returns true for an unused slug", async () => {
      const available = await isSlugAvailable("never-used-slug");
      expect(available).toBe(true);
    });

    it("returns false for a slug already in use", async () => {
      await createOrganization("Taken Org", "taken-slug", userId);

      const available = await isSlugAvailable("taken-slug");
      expect(available).toBe(false);
    });

    it("returns true again after the org is deleted", async () => {
      const org = await createOrganization("Del Org", "del-slug", userId);

      expect(await isSlugAvailable("del-slug")).toBe(false);

      // Import deleteOrganization for cleanup
      const { deleteOrganization } = await import("../../../src/services/organizations.ts");
      await deleteOrganization(org.id);

      expect(await isSlugAvailable("del-slug")).toBe(true);
    });
  });

  // ── provisionMember / removeMember / updateMemberRole ────

  describe("member management", () => {
    // The creator (`userId`) is the owner of every org built below; the actor's
    // role is re-read from its row by the service, never passed in.
    const asOwner = () => ({ userId, firstPartySession: true });
    const asDelegateOf = (id: string) => ({ userId: id, firstPartySession: false });

    it("provisionMember is idempotent for duplicate membership", async () => {
      const org = await createOrganization("Dup Org", "dup-org", userId);

      // Should not throw — duplicate is silently ignored
      await db.transaction((tx) => provisionMember(tx, org.id, userId, "member"));

      const members = await getOrgMembers(org.id);
      expect(members.filter((m) => m.userId === userId)).toHaveLength(1);
    });

    it("removeMember removes a member from the org", async () => {
      const org = await createOrganization("Rm Org", "rm-org", userId);
      const member = await createTestUser({ email: "removable@test.com" });
      await db.transaction((tx) => provisionMember(tx, org.id, member.id, "member"));

      await removeMember(org.id, member.id, asOwner());

      const members = await getOrgMembers(org.id);
      const memberIds = members.map((m) => m.userId);
      expect(memberIds).not.toContain(member.id);
    });

    it("removeMember answers 404 for a non-existent member", async () => {
      const org = await createOrganization("Rm2 Org", "rm2-org", userId);

      const error = await removeMember(
        org.id,
        "00000000-0000-0000-0000-000000000000",
        asOwner(),
      ).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 404, code: "not_found" });
    });

    it("removeMember refuses a target the actor may not manage, and keeps the row", async () => {
      const org = await createOrganization("Rm3 Org", "rm3-org", userId);
      const admin = await createTestUser();
      const peer = await createTestUser();
      await db.transaction((tx) => provisionMember(tx, org.id, admin.id, "admin"));
      await db.transaction((tx) => provisionMember(tx, org.id, peer.id, "admin"));

      await expect(
        removeMember(org.id, peer.id, { userId: admin.id, firstPartySession: true }),
      ).rejects.toMatchObject({ status: 403 });
      expect((await getOrgMembers(org.id)).map((m) => m.userId)).toContain(peer.id);
    });

    it("removeMember lets an owner remove a co-owner, on their own credential only", async () => {
      const org = await createOrganization("Co Org", "co-org", userId);
      const coOwner = await createTestUser();
      await db.transaction((tx) => provisionMember(tx, org.id, coOwner.id, "member"));
      await updateMemberRole(org.id, coOwner.id, "owner", asOwner());

      // A delegate (OAuth/MCP client) of the very same owner is refused.
      await expect(removeMember(org.id, coOwner.id, asDelegateOf(userId))).rejects.toMatchObject({
        status: 403,
      });
      expect((await ownerIds(org.id)).sort()).toEqual([userId, coOwner.id].sort());

      await removeMember(org.id, coOwner.id, asOwner());
      expect(await ownerIds(org.id)).toEqual([userId]);
    });

    it("removeMember lets a delegate manage non-owners as before", async () => {
      const org = await createOrganization("Deleg Org", "deleg-org", userId);
      const member = await createTestUser();
      await db.transaction((tx) => provisionMember(tx, org.id, member.id, "member"));

      await removeMember(org.id, member.id, asDelegateOf(userId));
      expect((await getOrgMembers(org.id)).map((m) => m.userId)).toEqual([userId]);
    });

    it("judges the actor on its role under the lock, not the one read at authentication", async () => {
      const org = await createOrganization("Stale Org", "stale-org", userId);
      const admin = await createTestUser();
      const member = await createTestUser();
      await db.transaction((tx) => provisionMember(tx, org.id, admin.id, "admin"));
      await db.transaction((tx) => provisionMember(tx, org.id, member.id, "member"));
      // Demoted by the owner after its request was authenticated as admin.
      await updateMemberRole(org.id, admin.id, "member", asOwner());

      const stale = { userId: admin.id, firstPartySession: true };
      await expect(removeMember(org.id, member.id, stale)).rejects.toMatchObject({ status: 403 });
      await expect(updateMemberRole(org.id, member.id, "guest", stale)).rejects.toMatchObject({
        status: 403,
      });
      expect((await getOrgMembers(org.id)).find((m) => m.userId === member.id)?.role).toBe(
        "member",
      );

      // An actor removed meanwhile is no member at all.
      await removeMember(org.id, admin.id, asOwner());
      await expect(removeMember(org.id, member.id, stale)).rejects.toMatchObject({ status: 403 });
    });

    it("removeMember revokes the member's API keys in THAT org only", async () => {
      const member = await createTestUser();
      const { org: org1, defaultSpaceId: space1 } = await createTestOrg(userId, {
        slug: "keys-org1",
      });
      await db.transaction((tx) => provisionMember(tx, org1.id, member.id, "member"));
      const { org: org2, defaultSpaceId: space2 } = await createTestOrg(member.id, {
        slug: "keys-org2",
      });
      const memberKey = await seedApiKey({ orgId: org1.id, spaceId: space1, createdBy: member.id });
      const ownerKey = await seedApiKey({ orgId: org1.id, spaceId: space1, createdBy: userId });
      const otherOrgKey = await seedApiKey({
        orgId: org2.id,
        spaceId: space2,
        createdBy: member.id,
      });

      const { revokedApiKeyIds } = await removeMember(org1.id, member.id, asOwner());
      expect(revokedApiKeyIds).toEqual([memberKey.id]);

      const revokedAt = async (id: string) =>
        (
          await db.select({ revokedAt: apiKeys.revokedAt }).from(apiKeys).where(eq(apiKeys.id, id))
        )[0]!.revokedAt;
      expect(await revokedAt(memberKey.id)).not.toBeNull();
      expect(await revokedAt(ownerKey.id)).toBeNull();
      expect(await revokedAt(otherOrgKey.id)).toBeNull();
    });

    // ── CRIT-13 — removeMember disables the member's schedules ──
    //
    // A removed member keeps their `user` row (multi-org), and schedules only
    // cascade on user-ACCOUNT or org deletion — without the transactional
    // disable inside removeMember, their schedules would keep firing under
    // the revoked identity. These regressions FAIL if that disable is
    // reverted.

    it("removeMember disables the member's enabled schedules in that org (CRIT-13)", async () => {
      const { org, defaultSpaceId } = await createTestOrg(userId, { slug: "sched-revoke" });
      const member = await createTestUser({ email: "sched-owner@test.com" });
      await db.transaction((tx) => provisionMember(tx, org.id, member.id, "member"));

      const pkg = await seedPackage({ orgId: org.id, id: "@sched-revoke/agent" });
      const memberSchedule = await seedSchedule({
        packageId: pkg.id,
        orgId: org.id,
        spaceId: defaultSpaceId,
        userId: member.id,
        enabled: true,
        nextRunAt: new Date(Date.now() + 3600_000),
      });
      // The OWNER's schedule must be untouched by the member's removal.
      const ownerSchedule = await seedSchedule({
        packageId: pkg.id,
        orgId: org.id,
        spaceId: defaultSpaceId,
        userId,
        enabled: true,
        nextRunAt: new Date(Date.now() + 3600_000),
      });

      await removeMember(org.id, member.id, asOwner());

      const [revoked] = await db
        .select({ enabled: schedules.enabled, nextRunAt: schedules.nextRunAt })
        .from(schedules)
        .where(eq(schedules.id, memberSchedule.id));
      // Disabled, not deleted — the row stays as org history.
      expect(revoked).toBeDefined();
      expect(revoked!.enabled).toBe(false);
      expect(revoked!.nextRunAt).toBeNull();

      const [untouched] = await db
        .select({ enabled: schedules.enabled, nextRunAt: schedules.nextRunAt })
        .from(schedules)
        .where(eq(schedules.id, ownerSchedule.id));
      expect(untouched!.enabled).toBe(true);
      expect(untouched!.nextRunAt).not.toBeNull();
    });

    it("removeMember only disables schedules in THAT org — the member's other-org schedules keep firing (CRIT-13)", async () => {
      const member = await createTestUser({ email: "multi-org-sched@test.com" });

      const { org: org1, defaultSpaceId: space1 } = await createTestOrg(userId, {
        slug: "rev-org1",
      });
      await db.transaction((tx) => provisionMember(tx, org1.id, member.id, "member"));
      const { org: org2, defaultSpaceId: space2 } = await createTestOrg(member.id, {
        slug: "rev-org2",
      });

      const pkg1 = await seedPackage({ orgId: org1.id, id: "@rev-org1/agent" });
      const pkg2 = await seedPackage({ orgId: org2.id, id: "@rev-org2/agent" });

      const inOrg1 = await seedSchedule({
        packageId: pkg1.id,
        orgId: org1.id,
        spaceId: space1,
        userId: member.id,
        enabled: true,
        nextRunAt: new Date(Date.now() + 3600_000),
      });
      const inOrg2 = await seedSchedule({
        packageId: pkg2.id,
        orgId: org2.id,
        spaceId: space2,
        userId: member.id,
        enabled: true,
        nextRunAt: new Date(Date.now() + 3600_000),
      });

      await removeMember(org1.id, member.id, asOwner());

      const [revoked] = await db
        .select({ enabled: schedules.enabled })
        .from(schedules)
        .where(eq(schedules.id, inOrg1.id));
      expect(revoked!.enabled).toBe(false);

      const [surviving] = await db
        .select({ enabled: schedules.enabled, nextRunAt: schedules.nextRunAt })
        .from(schedules)
        .where(eq(schedules.id, inOrg2.id));
      expect(surviving!.enabled).toBe(true);
      expect(surviving!.nextRunAt).not.toBeNull();
    });

    it("updateMemberRole changes the role", async () => {
      const org = await createOrganization("Role Org", "role2-org", userId);
      const member = await createTestUser({ email: "promote@test.com" });
      await db.transaction((tx) => provisionMember(tx, org.id, member.id, "member"));

      const { previousRole } = await updateMemberRole(org.id, member.id, "admin", asOwner());
      expect(previousRole).toBe("member");

      const allMembers = await getOrgMembers(org.id);
      const updated = allMembers.find((m) => m.userId === member.id);
      expect(updated).toBeDefined();
      expect(updated!.role).toBe("admin");
    });

    it("updateMemberRole offers owner to an owner only", async () => {
      const org = await createOrganization("Promo Org", "promo-org", userId);
      const admin = await createTestUser();
      const member = await createTestUser();
      await db.transaction((tx) => provisionMember(tx, org.id, admin.id, "admin"));
      await db.transaction((tx) => provisionMember(tx, org.id, member.id, "member"));

      await expect(
        updateMemberRole(org.id, member.id, "owner", { userId: admin.id, firstPartySession: true }),
      ).rejects.toMatchObject({ status: 403 });
      expect(await ownerIds(org.id)).toEqual([userId]);

      await updateMemberRole(org.id, member.id, "owner", asOwner());
      expect((await ownerIds(org.id)).sort()).toEqual([userId, member.id].sort());
    });

    it("updateMemberRole refuses a delegate granting or taking owner, not other roles", async () => {
      const org = await createOrganization("Deleg Role Org", "deleg-role-org", userId);
      const member = await createTestUser();
      const coOwner = await createTestUser();
      await db.transaction((tx) => provisionMember(tx, org.id, member.id, "member"));
      await db.transaction((tx) => provisionMember(tx, org.id, coOwner.id, "member"));
      await updateMemberRole(org.id, coOwner.id, "owner", asOwner());
      const delegate = asDelegateOf(userId);

      await expect(updateMemberRole(org.id, member.id, "owner", delegate)).rejects.toMatchObject({
        status: 403,
      });
      await expect(updateMemberRole(org.id, coOwner.id, "admin", delegate)).rejects.toMatchObject({
        status: 403,
      });
      expect((await ownerIds(org.id)).sort()).toEqual([userId, coOwner.id].sort());

      const { previousRole } = await updateMemberRole(org.id, member.id, "admin", delegate);
      expect(previousRole).toBe("member");
    });

    it("leaveOrganization removes a member and refuses the last owner", async () => {
      const org = await createOrganization("Leave Org", "leave-org", userId);
      const member = await createTestUser();
      await db.transaction((tx) => provisionMember(tx, org.id, member.id, "member"));

      await leaveOrganization(org.id, member.id);
      expect((await getOrgMembers(org.id)).map((m) => m.userId)).toEqual([userId]);

      await expect(leaveOrganization(org.id, userId)).rejects.toMatchObject({
        status: 409,
        code: "last_owner",
      });
      await expect(leaveOrganization(org.id, member.id)).rejects.toMatchObject({ status: 404 });
      expect(await ownerIds(org.id)).toEqual([userId]);
    });
  });

  // ── OAuth tokens die with the membership ────────────────
  //
  // A refresh through an org-level `allowSignup` client re-provisions the
  // membership, so the exit revokes the tokens of THIS org's own clients.
  describe("exit revokes the org's own OAuth tokens", () => {
    async function seedClient(clientId: string, level: "org" | "instance", orgId?: string) {
      await db.insert(oauthClient).values({
        id: clientId,
        clientId,
        redirectUris: ["https://client.test/cb"],
        level,
        referencedOrgId: level === "org" ? orgId : null,
      });
    }
    async function seedTokens(clientId: string, ownerId: string, resources?: string[]) {
      const refreshId = crypto.randomUUID();
      await db.insert(oauthRefreshToken).values({
        id: refreshId,
        token: `rt_${refreshId}`,
        clientId,
        userId: ownerId,
        scopes: ["openid"],
        resources,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      const accessId = crypto.randomUUID();
      await db.insert(oauthAccessToken).values({
        id: accessId,
        token: `at_${accessId}`,
        clientId,
        userId: ownerId,
        refreshId,
        scopes: ["openid"],
        resources,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      return { refreshId, accessId };
    }
    async function revokedState(tokens: { refreshId: string; accessId: string }) {
      const [refresh] = await db
        .select({ revoked: oauthRefreshToken.revoked })
        .from(oauthRefreshToken)
        .where(eq(oauthRefreshToken.id, tokens.refreshId));
      const [access] = await db
        .select({ revoked: oauthAccessToken.revoked })
        .from(oauthAccessToken)
        .where(eq(oauthAccessToken.id, tokens.accessId));
      return { refresh: refresh!.revoked !== null, access: access!.revoked !== null };
    }

    it("leaving revokes this org's client tokens and leaves the others", async () => {
      const org = await createOrganization("Tok Org", "tok-org", userId);
      const other = await createOrganization("Other Tok Org", "other-tok-org", userId);
      const member = await createTestUser();
      await db.transaction((tx) => provisionMember(tx, org.id, member.id, "member"));
      await db.transaction((tx) => provisionMember(tx, other.id, member.id, "member"));
      await seedClient("cli_this_org", "org", org.id);
      await seedClient("cli_other_org", "org", other.id);
      await seedClient("cli_instance", "instance");
      const thisOrg = await seedTokens("cli_this_org", member.id);
      const otherOrg = await seedTokens("cli_other_org", member.id);
      const instance = await seedTokens("cli_instance", member.id);
      // Witness: the same client's tokens held by someone who stays.
      const stayer = await seedTokens("cli_this_org", userId);

      await leaveOrganization(org.id, member.id);

      expect(await revokedState(thisOrg)).toEqual({ refresh: true, access: true });
      expect(await revokedState(otherOrg)).toEqual({ refresh: false, access: false });
      expect(await revokedState(instance)).toEqual({ refresh: false, access: false });
      expect(await revokedState(stayer)).toEqual({ refresh: false, access: false });
    });

    it("revokes instance-client tokens bound to this org's MCP resource, only those", async () => {
      const org = await createOrganization("Mcp Org", "mcp-org", userId);
      const other = await createOrganization("Other Mcp Org", "other-mcp-org", userId);
      const member = await createTestUser();
      await db.transaction((tx) => provisionMember(tx, org.id, member.id, "member"));
      await db.transaction((tx) => provisionMember(tx, other.id, member.id, "member"));
      await seedClient("cli_mcp", "instance");
      const bound = await seedTokens("cli_mcp", member.id, [getMcpOrgResourceUri(org.id)]);
      const otherBound = await seedTokens("cli_mcp", member.id, [getMcpOrgResourceUri(other.id)]);
      const unbound = await seedTokens("cli_mcp", member.id);

      await removeMember(org.id, member.id, { userId, firstPartySession: true });

      expect(await revokedState(bound)).toEqual({ refresh: true, access: true });
      expect(await revokedState(otherBound)).toEqual({ refresh: false, access: false });
      expect(await revokedState(unbound)).toEqual({ refresh: false, access: false });
    });
  });

  // ── `onOrgMemberRemove` fires from the service, for the exiting member ──
  //
  // A recording module in the loader registry — the same entry point boot uses
  // (see `organizations-delete-preconditions.test.ts`).
  describe("onOrgMemberRemove", () => {
    let calls: Array<[string, string]> = [];
    const recorder: AppstrateModule = {
      manifest: {
        id: "test-member-remove-recorder",
        name: "Member remove recorder",
        version: "1.0.0",
      },
      async init() {},
      events: {
        onOrgMemberRemove: async (orgId: string, removedUserId: string) => {
          calls.push([orgId, removedUserId]);
        },
      },
    };

    beforeAll(async () => {
      resetModules();
      await loadModulesFromInstances([recorder], buildModuleInitContext());
    });
    afterAll(async () => {
      // Back to the preload's registry; `getTestApp()` restores the RBAC
      // provider the reset nulls out (same teardown as the delete-preconditions suite).
      await restoreDiscoveredModules();
      getTestApp();
    });
    beforeEach(() => {
      calls = [];
    });

    it("fires once with the removed member's id, not the actor's", async () => {
      const org = await createOrganization("Evt Org", "evt-org", userId);
      const member = await createTestUser();
      await db.transaction((tx) => provisionMember(tx, org.id, member.id, "member"));

      await removeMember(org.id, member.id, { userId, firstPartySession: true });
      expect(calls).toEqual([[org.id, member.id]]);
    });

    it("fires once for a member who leaves", async () => {
      const org = await createOrganization("Evt Leave Org", "evt-leave-org", userId);
      const member = await createTestUser();
      await db.transaction((tx) => provisionMember(tx, org.id, member.id, "member"));

      await leaveOrganization(org.id, member.id);
      expect(calls).toEqual([[org.id, member.id]]);
    });

    it("does not fire on a refused exit", async () => {
      const org = await createOrganization("Evt Refused Org", "evt-refused-org", userId);
      const admin = await createTestUser();
      await db.transaction((tx) => provisionMember(tx, org.id, admin.id, "admin"));

      await expect(leaveOrganization(org.id, userId)).rejects.toMatchObject({ status: 409 });
      await expect(
        removeMember(org.id, userId, { userId: admin.id, firstPartySession: true }),
      ).rejects.toMatchObject({ status: 403 });
      expect(calls).toEqual([]);
    });
  });

  // ── The org keeps an owner under concurrency ─────────────
  //
  // Without `lockOrgOwnership` both writers read the other owner as present and
  // both commit, leaving zero owners — these can fail without the lock. PGlite
  // serialises on one connection, which would make them vacuous: Postgres only.
  describeRequiresPostgres("owner invariant under concurrent exits", () => {
    const ROUNDS = 5;

    async function twoOwnerOrg(round: number): Promise<{ orgId: string; coOwnerId: string }> {
      const org = await createOrganization(`Race ${round}`, `race-${round}`, userId);
      const coOwner = await createTestUser();
      await db.transaction((tx) => provisionMember(tx, org.id, coOwner.id, "member"));
      await updateMemberRole(org.id, coOwner.id, "owner", { userId, firstPartySession: true });
      return { orgId: org.id, coOwnerId: coOwner.id };
    }

    it("two owners leaving at once: exactly one leaves, one owner remains", async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const { orgId, coOwnerId } = await twoOwnerOrg(round);

        const results = await Promise.allSettled([
          leaveOrganization(orgId, userId),
          leaveOrganization(orgId, coOwnerId),
        ]);

        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const rejected = results.filter((r) => r.status === "rejected");
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
          status: 409,
          code: "last_owner",
        });
        expect(await ownerIds(orgId)).toHaveLength(1);
      }
    });

    it("an owner demoting the other while that one leaves keeps at least one owner", async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const { orgId, coOwnerId } = await twoOwnerOrg(round);

        await Promise.allSettled([
          updateMemberRole(orgId, coOwnerId, "member", { userId, firstPartySession: true }),
          leaveOrganization(orgId, userId),
        ]);

        expect((await ownerIds(orgId)).length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // ── slugify ───────────────────────────────────────────────

  describe("slugify", () => {
    it("converts name to lowercase slug", () => {
      expect(slugify("My Company")).toBe("my-company");
    });

    it("handles accented characters", () => {
      expect(slugify("Cafe Resume")).toBe("cafe-resume");
    });

    it("strips leading and trailing hyphens", () => {
      expect(slugify("--test--")).toBe("test");
    });

    it("truncates to 50 characters", () => {
      const long = "a".repeat(100);
      expect(slugify(long).length).toBeLessThanOrEqual(50);
    });
  });
});
