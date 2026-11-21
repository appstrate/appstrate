// SPDX-License-Identifier: Apache-2.0

/**
 * Offering a package to its organization (`PUT|DELETE /api/packages/{scope}/{name}/org-offer`,
 * RBAC spec §6.10): placed and active in every space of the organization that
 * holds no row of its own; a row always wins.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  integrationConnections,
  orgPackageOffers,
  packages,
  schedules,
  spacePackages,
  spaces,
} from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { expectProblem } from "../../helpers/assertions.ts";
import {
  addOrgMember,
  authHeaders,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedApiKey,
  seedOrgOffer,
  seedPackage,
  seedPublishedVersion,
  seedSchedule,
  seedSpace,
  seedSpacePackage,
} from "../../helpers/seed.ts";
import { isPackageActiveHere, updateSpacePackage } from "../../../src/services/space-packages.ts";
import { sharePackage } from "../../../src/services/package-shares.ts";
import { reconcilePlacementsAfterRehome } from "../../../src/services/package-placement.ts";
import { emptyAndDeletePersonalSpace } from "../../../src/services/spaces.ts";
import { isPackageReadableInSpace } from "../../../src/lib/package-access.ts";
import { __resetSystemIntegrationsForTest } from "../../../src/services/integration-client-registry.ts";

const app = getTestApp();

const AGENT = "@offers/worker";
const DRAFT_ONLY = "@offers/draft";
/** A catalog integration the deployment ships but does not auto-activate. */
const CATALOG_SSH = "@offers/ssh";

type Headers = Record<string, string>;

interface Principal {
  userId: string;
  personalSpaceId: string;
  headers: (spaceId?: string) => Headers;
}

let ctx: TestContext;
let teamId: string;
let admin: Principal;
let member: Principal;
let other: Principal;

async function principal(orgRole: "admin" | "member"): Promise<Principal> {
  const user = await createTestUser();
  await addOrgMember(ctx.orgId, user.id, orgRole);
  const listed = await app.request("/api/spaces", {
    headers: { Cookie: user.cookie, "X-Org-Id": ctx.orgId },
  });
  expect(listed.status, await listed.clone().text()).toBe(200);
  const spaces = (await listed.json()) as { data: { id: string; personal: boolean }[] };
  const own = spaces.data.find((space) => space.personal)!;
  return {
    userId: user.id,
    personalSpaceId: own.id,
    headers: (spaceId = own.id) => ({
      Cookie: user.cookie,
      "X-Org-Id": ctx.orgId,
      "X-Space-Id": spaceId,
    }),
  };
}

const offer = (headers: Headers, packageId: string) =>
  app.request(`/api/packages/${packageId}/org-offer`, { method: "PUT", headers });
const withdraw = (headers: Headers, packageId: string) =>
  app.request(`/api/packages/${packageId}/org-offer`, { method: "DELETE", headers });

const offerRows = (packageId: string) =>
  db.select().from(orgPackageOffers).where(eq(orgPackageOffers.packageId, packageId));

interface ContextEntry {
  integration_package_id: string;
  active: boolean;
  connections: { id: string }[];
}

/** The integration entry the caller's `GET /api/me/context` lists in `spaceId`, active or not. */
async function contextEntry(
  p: Principal,
  spaceId: string,
  integrationId: string,
): Promise<ContextEntry | undefined> {
  const res = await app.request("/api/me/context", { headers: p.headers(spaceId) });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { connections: ContextEntry[] };
  return body.connections.find((c) => c.integration_package_id === integrationId);
}

/** An org-scoped connection of `userId`, reachable from every space of its owner. */
async function seedOrgConnection(userId: string, integrationId: string) {
  await db.insert(integrationConnections).values({
    integrationId,
    authKey: "ssh",
    accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
    orgId: ctx.orgId,
    spaceId: null,
    originSpaceId: teamId,
    userId,
    credentialsEncrypted: "x",
    scopesGranted: [],
    label: "Bastion",
  });
}

async function libraryPlacement(p: Principal, packageId: string, type: string, spaceId: string) {
  const res = await app.request(`/api/spaces/${spaceId}/library`, {
    headers: { Cookie: p.headers()["Cookie"]!, "X-Org-Id": ctx.orgId },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as {
    packages: Record<
      string,
      {
        id: string;
        offered_to_org: boolean;
        org_offerable: boolean;
        placements: { space_id: string; via: string; state: string; shared_by: null }[];
      }[]
    >;
  };
  return body.packages[type]!.find((row) => row.id === packageId);
}

beforeEach(async () => {
  await truncateAll();
  __resetSystemIntegrationsForTest();
  ctx = await createTestContext({ orgSlug: "offers" });
  teamId = (await seedSpace({ orgId: ctx.orgId, name: "Team", visibility: "closed" })).id;
  await seedPackage({
    id: AGENT,
    orgId: ctx.orgId,
    type: "agent",
    homeSpaceId: teamId,
    createdBy: ctx.user.id,
    draftManifest: { name: AGENT, version: "0.1.0", type: "agent", description: "Worker" },
  });
  await seedPublishedVersion(AGENT, "0.1.0");
  await seedPackage({
    id: DRAFT_ONLY,
    orgId: ctx.orgId,
    type: "agent",
    homeSpaceId: teamId,
    draftManifest: { name: DRAFT_ONLY, version: "0.1.0", type: "agent", description: "Draft" },
  });
  await seedPackage({
    id: CATALOG_SSH,
    orgId: null,
    type: "integration",
    source: "system",
    draftManifest: { name: CATALOG_SSH, version: "1.0.0", type: "integration" },
  });
  admin = await principal("admin");
  member = await principal("member");
  other = await principal("member");
});

describe("PUT/DELETE /api/packages/{scope}/{name}/org-offer", () => {
  it("lets an admin offer, is idempotent, and audits once", async () => {
    const first = await offer(admin.headers(teamId), AGENT);
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.json()).toEqual({
      object: "package_org_offer",
      packageId: AGENT,
      offered_to_org: true,
    });
    const second = await offer(admin.headers(teamId), AGENT);
    expect(second.status).toBe(200);
    expect(await offerRows(AGENT)).toHaveLength(1);
    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "package.offered_to_org"));
    expect(audits).toHaveLength(1);
  });

  it("refuses a plain member, whatever the package", async () => {
    const res = await offer(member.headers(), AGENT);
    expect(res.status).toBe(403);
    expect(await offerRows(AGENT)).toHaveLength(0);
    expect((await withdraw(member.headers(), AGENT)).status).toBe(403);
  });

  it("answers 404 to an admin for a package homed in another member's personal space", async () => {
    await seedPackage({
      id: "@offers/private",
      orgId: ctx.orgId,
      type: "agent",
      homeSpaceId: member.personalSpaceId,
      draftManifest: { name: "@offers/private", version: "0.1.0", type: "agent" },
    });
    await seedPublishedVersion("@offers/private", "0.1.0");
    const res = await offer(admin.headers(teamId), "@offers/private");
    expect(res.status).toBe(404);
    expect(await offerRows("@offers/private")).toHaveLength(0);
  });

  it("refuses a package homed in a space without a published version, but not a system one", async () => {
    const draft = await offer(authHeaders(ctx, { "X-Space-Id": teamId }), DRAFT_ONLY);
    await expectProblem(draft, 409, { code: "package_has_no_version" });
    const system = await offer(authHeaders(ctx), CATALOG_SSH);
    expect(system.status, await system.clone().text()).toBe(200);
  });

  it("refuses a credential confined to a space", async () => {
    const key = await seedApiKey({ orgId: ctx.orgId, spaceId: teamId, createdBy: ctx.user.id });
    const res = await offer(
      { Authorization: `Bearer ${key.rawKey}`, "X-Org-Id": ctx.orgId, "X-Space-Id": teamId },
      AGENT,
    );
    expect([401, 403]).toContain(res.status);
    expect(await offerRows(AGENT)).toHaveLength(0);
  });
});

describe("an offered package is placed and active where no row says otherwise", () => {
  it("activates a catalog integration in a member's personal space, and lists it with a reachable connection", async () => {
    await seedOrgConnection(member.userId, CATALOG_SSH);
    expect((await contextEntry(member, member.personalSpaceId, CATALOG_SSH))?.active).not.toBe(
      true,
    );

    expect((await offer(authHeaders(ctx), CATALOG_SSH)).status).toBe(200);

    const entry = await contextEntry(member, member.personalSpaceId, CATALOG_SSH);
    expect(entry?.active).toBe(true);
    expect(entry?.connections).toHaveLength(1);
  });

  it("keeps a space that holds an enabled=false row off", async () => {
    await seedOrgConnection(member.userId, CATALOG_SSH);
    await seedSpacePackage(member.personalSpaceId, CATALOG_SSH, { enabled: false });
    expect((await offer(authHeaders(ctx), CATALOG_SSH)).status).toBe(200);
    expect((await contextEntry(member, member.personalSpaceId, CATALOG_SSH))?.active).toBe(false);
  });

  it("shows via organization in a space library, active, and the offer flags to an admin", async () => {
    expect((await offer(authHeaders(ctx, { "X-Space-Id": teamId }), AGENT)).status).toBe(200);
    const row = await libraryPlacement(member, AGENT, "agent", member.personalSpaceId);
    expect(row?.offered_to_org).toBe(true);
    expect(row?.org_offerable).toBe(false);
    expect(row?.placements).toEqual([
      { space_id: member.personalSpaceId, via: "organization", state: "active", shared_by: null },
    ]);
    const asAdmin = await libraryPlacement(admin, AGENT, "agent", admin.personalSpaceId);
    expect(asAdmin?.org_offerable).toBe(true);
  });

  it("is not visible to another organization's spaces", async () => {
    expect((await offer(authHeaders(ctx, { "X-Space-Id": teamId }), AGENT)).status).toBe(200);
    const foreign = await createTestContext({ orgSlug: "foreign" });
    const res = await app.request(`/api/spaces/${foreign.defaultSpaceId}/library`, {
      headers: authHeaders(foreign),
    });
    const body = (await res.json()) as { packages: Record<string, { id: string }[]> };
    expect(body.packages["agent"]!.map((p) => p.id)).not.toContain(AGENT);
  });
});

describe("withdrawing the offer", () => {
  it("disables schedules only in spaces without a row of their own", async () => {
    expect((await offer(authHeaders(ctx, { "X-Space-Id": teamId }), AGENT)).status).toBe(200);
    // Active by the offer alone.
    const viaOffer = await seedSchedule({
      orgId: ctx.orgId,
      spaceId: member.personalSpaceId,
      packageId: AGENT,
      userId: member.userId,
    });
    // Active by a row of its own.
    await seedSpacePackage(other.personalSpaceId, AGENT);
    const viaRow = await seedSchedule({
      orgId: ctx.orgId,
      spaceId: other.personalSpaceId,
      packageId: AGENT,
      userId: other.userId,
    });
    // The home keeps the package placed: its schedule is left armed.
    const atHome = await seedSchedule({
      orgId: ctx.orgId,
      spaceId: teamId,
      packageId: AGENT,
      userId: ctx.user.id,
    });

    const res = await withdraw(authHeaders(ctx, { "X-Space-Id": teamId }), AGENT);
    expect(res.status).toBe(204);
    expect(await offerRows(AGENT)).toHaveLength(0);

    const read = async (id: string) =>
      (await db.select().from(schedules).where(eq(schedules.id, id)))[0]!;
    expect((await read(viaOffer.id)).enabled).toBe(false);
    expect((await read(viaOffer.id)).disabledReason).toBe("package_removed");
    expect((await read(viaRow.id)).enabled).toBe(true);
    expect((await read(atHome.id)).enabled).toBe(true);

    const audits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "package.offer_withdrawn")));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.after)).toContain(viaOffer.id);
  });

  it("is idempotent", async () => {
    expect((await withdraw(authHeaders(ctx), CATALOG_SSH)).status).toBe(204);
    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "package.offer_withdrawn"));
    expect(audits).toHaveLength(0);
  });
});

const rowIn = async (spaceId: string, packageId: string) =>
  (
    await db
      .select()
      .from(spacePackages)
      .where(and(eq(spacePackages.spaceId, spaceId), eq(spacePackages.packageId, packageId)))
  )[0];

const configure = (spaceId: string, packageId: string) =>
  updateSpacePackage({ orgId: ctx.orgId, spaceId }, packageId, {
    inputSettings: { values: {}, locked: [] },
  });

describe("a row created under the offer is a decision about the offer, not a placement", () => {
  it("configuring in a space under the offer, then withdrawing, leaves nothing placed or active there", async () => {
    await offer(authHeaders(ctx, { "X-Space-Id": teamId }), AGENT);
    await configure(member.personalSpaceId, AGENT);
    expect((await rowIn(member.personalSpaceId, AGENT))?.placedByOffer).toBe(true);
    const schedule = await seedSchedule({
      orgId: ctx.orgId,
      spaceId: member.personalSpaceId,
      packageId: AGENT,
      userId: member.userId,
    });

    expect((await withdraw(authHeaders(ctx, { "X-Space-Id": teamId }), AGENT)).status).toBe(204);

    expect(await rowIn(member.personalSpaceId, AGENT)).toBeUndefined();
    expect(await isPackageReadableInSpace(member.personalSpaceId, AGENT)).toBe(false);
    expect(
      await isPackageActiveHere({ orgId: ctx.orgId, spaceId: member.personalSpaceId }, AGENT),
    ).toBe(false);
    const [after] = await db.select().from(schedules).where(eq(schedules.id, schedule.id));
    expect(after!.enabled).toBe(false);
    expect(after!.disabledReason).toBe("package_removed");
  });

  it("activating an already-offered package answers 200 and records an offer row", async () => {
    await offer(authHeaders(ctx, { "X-Space-Id": teamId }), AGENT);
    const res = await app.request(`/api/spaces/${member.personalSpaceId}/packages`, {
      method: "POST",
      headers: { ...member.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ packageId: AGENT }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const row = await rowIn(member.personalSpaceId, AGENT);
    expect(row?.enabled).toBe(true);
    expect(row?.placedByOffer).toBe(true);
  });

  it("keeps an opt-out when a share is revoked while the package is offered", async () => {
    await seedSpacePackage(member.personalSpaceId, AGENT, { enabled: false });
    await offer(authHeaders(ctx, { "X-Space-Id": teamId }), AGENT);
    const res = await app.request(`/api/packages/${AGENT}/shares/${member.personalSpaceId}`, {
      method: "DELETE",
      headers: member.headers(),
    });
    expect(res.status, await res.clone().text()).toBe(204);
    const row = await rowIn(member.personalSpaceId, AGENT);
    expect(row?.enabled).toBe(false);
    expect(row?.placedByOffer).toBe(true);
    expect(
      await isPackageActiveHere({ orgId: ctx.orgId, spaceId: member.personalSpaceId }, AGENT),
    ).toBe(false);
  });

  it("keeps an opt-out through a home move that drops the old home's row", async () => {
    const third = (await seedSpace({ orgId: ctx.orgId, name: "Third", visibility: "closed" })).id;
    await seedSpacePackage(teamId, AGENT, { enabled: false });
    await offer(authHeaders(ctx, { "X-Space-Id": teamId }), AGENT);
    const ids = await db.transaction((tx) =>
      reconcilePlacementsAfterRehome(tx, {
        packageId: AGENT,
        newHomeSpaceId: third,
        previousHome: { spaceId: teamId, keep: false },
      }),
    );
    expect(ids).toEqual([]);
    const row = await rowIn(teamId, AGENT);
    expect(row?.enabled).toBe(false);
    expect(row?.placedByOffer).toBe(true);
  });

  it("a row of the new home is no offer row: withdrawing the offer after the move keeps it", async () => {
    const third = (await seedSpace({ orgId: ctx.orgId, name: "Third", visibility: "closed" })).id;
    await offer(authHeaders(ctx, { "X-Space-Id": teamId }), AGENT);
    await configure(third, AGENT);
    const schedule = await seedSchedule({
      orgId: ctx.orgId,
      spaceId: third,
      packageId: AGENT,
      userId: ctx.user.id,
    });
    await db.transaction((tx) =>
      reconcilePlacementsAfterRehome(tx, {
        packageId: AGENT,
        newHomeSpaceId: third,
        previousHome: { spaceId: teamId, keep: true },
      }),
    );
    await db.update(packages).set({ homeSpaceId: third }).where(eq(packages.id, AGENT));
    expect((await rowIn(third, AGENT))?.placedByOffer).toBe(false);

    expect((await withdraw(authHeaders(ctx, { "X-Space-Id": teamId }), AGENT)).status).toBe(204);

    const row = await rowIn(third, AGENT);
    expect(row?.inputSettings).toEqual({ values: {}, locked: [] });
    const [after] = await db.select().from(schedules).where(eq(schedules.id, schedule.id));
    expect(after!.enabled).toBe(true);
  });

  it("a real share over an offer row survives the withdrawal", async () => {
    await offer(authHeaders(ctx, { "X-Space-Id": teamId }), AGENT);
    await configure(member.personalSpaceId, AGENT);
    const shared = await sharePackage({
      packageId: AGENT,
      spaceId: member.personalSpaceId,
      orgId: ctx.orgId,
      placeAs: { sharedBy: ctx.user.id, authorizeHome: () => true },
      enabled: true,
    });
    expect(shared.created).toBe(true);
    expect((await rowIn(member.personalSpaceId, AGENT))?.placedByOffer).toBe(false);

    await withdraw(authHeaders(ctx, { "X-Space-Id": teamId }), AGENT);
    expect(await rowIn(member.personalSpaceId, AGENT)).toBeDefined();
    const listed = await app.request(`/api/packages/${AGENT}/shares`, {
      headers: authHeaders(ctx, { "X-Space-Id": teamId }),
    });
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(1);
  });

  it("does not list an offer row as a share, and reports it via organization", async () => {
    await offer(authHeaders(ctx, { "X-Space-Id": teamId }), AGENT);
    await configure(member.personalSpaceId, AGENT);
    const listed = await app.request(`/api/packages/${AGENT}/shares`, {
      headers: authHeaders(ctx, { "X-Space-Id": teamId }),
    });
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(0);
    const row = await libraryPlacement(member, AGENT, "agent", member.personalSpaceId);
    expect(row?.placements.map((p) => p.via)).toEqual(["organization"]);
  });

  it("re-homes an offered package when its author's personal space is swept", async () => {
    await seedPackage({
      id: "@offers/personal",
      orgId: ctx.orgId,
      type: "agent",
      homeSpaceId: member.personalSpaceId,
      draftManifest: { name: "@offers/personal", version: "0.1.0", type: "agent" },
    });
    await seedOrgOffer(ctx.orgId, "@offers/personal");
    await db
      .update(spaces)
      .set({ orphanedAt: new Date(Date.now() - 90 * 86_400_000) })
      .where(eq(spaces.id, member.personalSpaceId));
    const swept = await emptyAndDeletePersonalSpace(ctx.orgId, member.personalSpaceId);
    expect(swept.counts).toEqual({ rehomedPackages: 1, deletedPackages: 0 });
    const [pkg] = await db.select().from(packages).where(eq(packages.id, "@offers/personal"));
    expect(pkg?.homeSpaceId).toBe(ctx.defaultSpaceId);
    expect(await offerRows("@offers/personal")).toHaveLength(1);
  });
});
