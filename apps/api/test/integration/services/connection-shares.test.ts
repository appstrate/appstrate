// SPDX-License-Identifier: Apache-2.0

/**
 * `shareConnection` / `unshareConnection`: one `integration_connection_shares` row per
 * (connection, space). Only the owner shares; the owner or a governor of the request space
 * withdraws. The two invariants the table does not enforce (an end user's row is never shared, a
 * space-scoped row only into its own space) are the service's, and pinned here.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db, truncateAll } from "../../helpers/db.ts";
import { seedShares, testCaller } from "../../helpers/connection-shares.ts";
import {
  addOrgMember,
  authHeaders,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedEndUser,
  seedPackage,
  seedPlacedPackage,
  seedSchedule,
  seedSpace,
} from "../../helpers/seed.ts";
import {
  integrationConnectionShares,
  organizationMembers,
  integrationConnections,
  integrationPins,
  schedules,
} from "@appstrate/db/schema";
import type { Permission } from "../../../src/lib/permissions.ts";
import type { Actor } from "../../../src/lib/actor.ts";
import {
  setConnectionFutureSharing,
  shareConnection,
  unshareConnection,
} from "../../../src/services/connection-shares.ts";
import type { ConnectionCaller } from "../../../src/services/connection-reach.ts";

import { createSpace } from "../../../src/services/spaces.ts";
import { getTestApp } from "../../helpers/app.ts";
import { removeMember, updateMemberRole } from "../../../src/services/organizations.ts";

const INTEGRATION = "@official/gmail";

const CONNECT: ReadonlySet<Permission> = new Set<Permission>(["integrations:connect"]);
const GOVERN: ReadonlySet<Permission> = new Set<Permission>([
  "integrations:connect",
  "integrations:configure",
]);
const NOTHING: ReadonlySet<Permission> = new Set<Permission>();

/** A connection serving `spaceId`: org-scoped, connected from it, or scoped to it. */
async function seedConnection(opts: {
  spaceId: string;
  orgScope?: boolean;
  userId?: string | null;
  endUserId?: string | null;
}): Promise<string> {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      integrationId: INTEGRATION,
      authKey: "google",
      accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
      orgId: sql`(SELECT org_id FROM spaces WHERE id = ${opts.spaceId})`,
      spaceId: opts.orgScope ? null : opts.spaceId,
      originSpaceId: opts.orgScope ? opts.spaceId : null,
      userId: opts.userId ?? null,
      endUserId: opts.endUserId ?? null,
      credentialsEncrypted: "x",
      scopesGranted: ["openid", "email"],
      label: `Connexion ${crypto.randomUUID().slice(0, 8)}`,
    })
    .returning({ id: integrationConnections.id });
  return row!.id;
}

async function sharesOf(connectionId: string) {
  return db
    .select({ spaceId: integrationConnectionShares.spaceId })
    .from(integrationConnectionShares)
    .where(eq(integrationConnectionShares.connectionId, connectionId));
}

async function seedShare(connectionId: string, spaceId: string): Promise<void> {
  await seedShares(connectionId, [spaceId]);
}

describe("connection shares", () => {
  let ctx: TestContext;
  let here: string;
  let other: string;
  let memberId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "sharesorg" });
    here = ctx.defaultSpaceId;
    other = (await seedSpace({ orgId: ctx.orgId, name: "Other" })).id;
    await seedPackage({ id: INTEGRATION, orgId: ctx.orgId, type: "integration", source: "local" });
    const member = await createTestUser();
    memberId = member.id;
    await addOrgMember(ctx.orgId, member.id);
  });

  const person = (id: string): Actor => ({ type: "user", id });

  /** The owner on the account surface (no request space), holding `permissions` in every target. */
  const owner = (permissions = CONNECT): ConnectionCaller =>
    testCaller(
      { kind: "person", actor: person(memberId) },
      { permissionsIn: async () => permissions },
    );

  /** The org owner governing `here`, never the row's owner. */
  const governor = (): ConnectionCaller =>
    testCaller(
      { kind: "person", actor: person(ctx.user.id) },
      { spaceId: here, governs: true, permissionsIn: async () => GOVERN },
    );

  const orgOwner = () =>
    testCaller(
      { kind: "person", actor: person(ctx.user.id) },
      {
        canShareAll: true,
        permissionsIn: async () => GOVERN,
      },
    );

  it("shares current and future team spaces, with durable exceptions and an off switch", async () => {
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: ctx.user.id });
    const input = { connectionId: id, integrationId: INTEGRATION, caller: orgOwner() };
    const app = await getTestApp();
    const response = await app.request("/api/me/connections/" + id + "/shares", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ include_future_spaces: true }),
    });
    expect(response.status).toBe(204);
    expect((await sharesOf(id)).map((s) => s.spaceId).sort()).toEqual([here, other].sort());
    const future = await createSpace(ctx.orgId, { name: "Future team" }, ctx.user.id);
    expect((await sharesOf(id)).some((s) => s.spaceId === future.id)).toBe(true);
    // Existing unshare/pin/schedule behavior stays the authority, also with future sharing on.
    await unshareConnection({ ...input, spaceId: other });
    await createSpace(ctx.orgId, { name: "Another team" });
    expect((await sharesOf(id)).some((s) => s.spaceId === other)).toBe(false);
    const before = await sharesOf(id);
    await setConnectionFutureSharing({ ...input, enabled: false });
    const excludedFuture = await createSpace(ctx.orgId, { name: "Not auto-shared" });
    expect(await sharesOf(id)).toEqual(before);
    expect((await sharesOf(id)).some((s) => s.spaceId === excludedFuture.id)).toBe(false);
  });

  it("refuses a member, another owner, a space-scoped row and a delegated credential", async () => {
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: memberId });
    for (const caller of [
      owner(GOVERN),
      orgOwner(),
      testCaller(
        {
          kind: "delegated",
          actor: person(memberId),
          orgId: ctx.orgId,
          spaceId: null,
        },
        { canShareAll: true },
      ),
    ]) {
      await expect(
        setConnectionFutureSharing({
          connectionId: id,
          integrationId: INTEGRATION,
          caller,
          enabled: true,
        }),
      ).rejects.toMatchObject({ status: expect.any(Number) });
    }
    const scoped = await seedConnection({ spaceId: here, userId: ctx.user.id });
    await expect(
      setConnectionFutureSharing({
        connectionId: scoped,
        integrationId: INTEGRATION,
        caller: orgOwner(),
        enabled: true,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await sharesOf(id)).toEqual([]);
  });

  it("never shares another organization's new spaces or personal spaces", async () => {
    const personal = await seedSpace({
      orgId: ctx.orgId,
      name: "Private",
      ownerUserId: memberId,
      visibility: "private",
    });
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: ctx.user.id });
    await setConnectionFutureSharing({
      connectionId: id,
      integrationId: INTEGRATION,
      caller: orgOwner(),
      enabled: true,
    });
    const elsewhere = await createTestContext({ orgSlug: "elsewhere" });
    const foreign = await createSpace(elsewhere.orgId, { name: "Foreign" });
    expect((await sharesOf(id)).map((s) => s.spaceId).sort()).toEqual([here, other].sort());
    expect(
      (await sharesOf(id)).some((s) => s.spaceId === personal.id || s.spaceId === foreign.id),
    ).toBe(false);
  });

  it("revokes future sharing when the owner loses org administration", async () => {
    await db
      .update(organizationMembers)
      .set({ role: "admin" })
      .where(
        and(eq(organizationMembers.orgId, ctx.orgId), eq(organizationMembers.userId, memberId)),
      );
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: memberId });
    await setConnectionFutureSharing({
      connectionId: id,
      integrationId: INTEGRATION,
      caller: { ...owner(GOVERN), canShareAll: true },
      enabled: true,
    });
    await updateMemberRole(ctx.orgId, memberId, "member", {
      userId: ctx.user.id,
      firstPartySession: true,
    });
    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, id));
    expect(row!.shareNewSpaces).toBe(false);
    const future = await createSpace(ctx.orgId, { name: "After demotion" });
    expect((await sharesOf(id)).some((s) => s.spaceId === future.id)).toBe(false);
  });

  it("clears future consent on departure so reinviting an admin cannot silently restore it", async () => {
    await db
      .update(organizationMembers)
      .set({ role: "admin" })
      .where(
        and(eq(organizationMembers.orgId, ctx.orgId), eq(organizationMembers.userId, memberId)),
      );
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: memberId });
    await setConnectionFutureSharing({
      connectionId: id,
      integrationId: INTEGRATION,
      caller: { ...owner(GOVERN), canShareAll: true },
      enabled: true,
    });
    await removeMember(ctx.orgId, memberId, { userId: ctx.user.id, firstPartySession: true });
    await addOrgMember(ctx.orgId, memberId, "admin");
    await createSpace(ctx.orgId, { name: "After re-invite" });
    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, id));
    expect(row!.shareNewSpaces).toBe(false);
    expect(await sharesOf(id)).toEqual([]);
  });

  it("the owner shares once: added, then idempotent, one row", async () => {
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: memberId });
    const first = await shareConnection({
      connectionId: id,
      spaceId: other,
      integrationId: INTEGRATION,
      caller: owner(),
    });
    expect(first.added).toBe(true);
    const second = await shareConnection({
      connectionId: id,
      spaceId: other,
      integrationId: INTEGRATION,
      caller: owner(),
    });
    expect(second.added).toBe(false);
    expect(await sharesOf(id)).toEqual([{ spaceId: other }]);
  });

  it("refuses a governor's share of a colleague's row (403)", async () => {
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: memberId });
    await seedShare(id, here);
    await expect(
      shareConnection({
        connectionId: id,
        spaceId: here,
        integrationId: INTEGRATION,
        caller: governor(),
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a space-scoped row into another space (400 invalid_share_target)", async () => {
    const id = await seedConnection({ spaceId: here, userId: memberId });
    await expect(
      shareConnection({
        connectionId: id,
        spaceId: other,
        integrationId: INTEGRATION,
        caller: owner(),
      }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_share_target" });
    expect(await sharesOf(id)).toEqual([]);
  });

  it("refuses an end user's row (409 end_user_connection_not_shareable)", async () => {
    const endUser = await seedEndUser({ orgId: ctx.orgId, spaceId: here, externalId: "ext-eu" });
    const id = await seedConnection({ spaceId: here, endUserId: endUser.id });
    const actor: Actor = { type: "end_user", id: endUser.id };
    await expect(
      shareConnection({
        connectionId: id,
        spaceId: here,
        integrationId: INTEGRATION,
        caller: testCaller(
          { kind: "delegated", actor, orgId: ctx.orgId, spaceId: here },
          { spaceId: here, permissionsIn: async () => CONNECT },
        ),
      }),
    ).rejects.toMatchObject({ status: 409, code: "end_user_connection_not_shareable" });
  });

  it("refuses a target where the owner lacks integrations:connect (403)", async () => {
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: memberId });
    await expect(
      shareConnection({
        connectionId: id,
        spaceId: other,
        integrationId: INTEGRATION,
        caller: owner(NOTHING),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await sharesOf(id)).toEqual([]);
  });

  it("a target blocking user connections takes a sharer configuring it there", async () => {
    await seedPlacedPackage(other, INTEGRATION, { blockUserConnections: true });
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: memberId });
    await expect(
      shareConnection({
        connectionId: id,
        spaceId: other,
        integrationId: INTEGRATION,
        caller: owner(CONNECT),
      }),
    ).rejects.toMatchObject({ status: 403, code: "connection_blocked_by_admin" });
    const { added } = await shareConnection({
      connectionId: id,
      spaceId: other,
      integrationId: INTEGRATION,
      caller: owner(GOVERN),
    });
    expect(added).toBe(true);
  });

  it("a governor withdraws a colleague's share here, never another space's (403)", async () => {
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: memberId });
    await seedShare(id, here);
    await seedShare(id, other);
    await expect(
      unshareConnection({
        connectionId: id,
        spaceId: other,
        integrationId: INTEGRATION,
        caller: governor(),
      }),
    ).rejects.toMatchObject({ status: 403 });
    const { removed } = await unshareConnection({
      connectionId: id,
      spaceId: here,
      integrationId: INTEGRATION,
      caller: governor(),
    });
    expect(removed).toBe(true);
    expect((await sharesOf(id)).map((s) => s.spaceId)).toEqual([other]);
  });

  it("refuses withdrawing a share an admin pin of that space names (409 connection_pinned)", async () => {
    const AGENT = "@sharesorg/pinned-agent";
    await seedPackage({ id: AGENT, orgId: ctx.orgId, type: "agent", homeSpaceId: here });
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: memberId });
    await seedShare(id, here);
    await db.insert(integrationPins).values({
      spaceId: here,
      packageId: AGENT,
      integrationId: INTEGRATION,
      userId: null,
      connectionIds: [id],
    });
    await expect(
      unshareConnection({
        connectionId: id,
        spaceId: here,
        integrationId: INTEGRATION,
        caller: owner(),
      }),
    ).rejects.toMatchObject({ status: 409, code: "connection_pinned" });
    expect((await sharesOf(id)).map((s) => s.spaceId)).toEqual([here]);
  });

  it("withdrawing a share that does not exist reports removed: false", async () => {
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: memberId });
    const result = await unshareConnection({
      connectionId: id,
      spaceId: other,
      integrationId: INTEGRATION,
      caller: owner(),
    });
    expect(result).toMatchObject({ removed: false, disabledScheduleIds: [] });
  });

  it("disables another member's enabled schedule naming the row in the withdrawn space", async () => {
    const AGENT = "@sharesorg/share-agent";
    await seedPackage({ id: AGENT, orgId: ctx.orgId, type: "agent", homeSpaceId: here });
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: memberId });
    await seedShare(id, here);
    const schedule = await seedSchedule({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: here,
      userId: ctx.user.id,
      connectionOverrides: { [INTEGRATION]: [id] },
    });

    const { disabledScheduleIds } = await unshareConnection({
      connectionId: id,
      spaceId: here,
      integrationId: INTEGRATION,
      caller: owner(),
    });

    expect(disabledScheduleIds).toEqual([schedule.id]);
    const [row] = await db
      .select({ enabled: schedules.enabled, reason: schedules.disabledReason })
      .from(schedules)
      .where(eq(schedules.id, schedule.id));
    expect(row).toEqual({ enabled: false, reason: "connection_unshared" });
  });
});
