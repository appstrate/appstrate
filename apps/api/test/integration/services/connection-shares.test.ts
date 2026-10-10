// SPDX-License-Identifier: Apache-2.0

/**
 * `shareConnection` / `unshareConnection`: one `integration_connection_shares` row per
 * (connection, space). Only the owner shares; the owner or a governor of the request space
 * withdraws. The two invariants the table does not enforce (an end user's row is never shared, a
 * space-scoped row only into its own space) are the service's, and pinned here.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db, truncateAll } from "../../helpers/db.ts";
import { seedShares } from "../../helpers/connection-shares.ts";
import {
  addOrgMember,
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
  integrationConnections,
  integrationPins,
  schedules,
} from "@appstrate/db/schema";
import type { Permission } from "../../../src/lib/permissions.ts";
import type { Actor } from "../../../src/lib/actor.ts";
import {
  shareConnection,
  unshareConnection,
  type ConnectionViewer,
} from "../../../src/services/connection-shares.ts";

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
    .select({
      spaceId: integrationConnectionShares.spaceId,
      sharedBy: integrationConnectionShares.sharedBy,
    })
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
  const owner = (permissions = CONNECT, spaceId: string | null = null): ConnectionViewer => ({
    principal: { kind: "person", actor: person(memberId) },
    spaceId,
    integrationId: INTEGRATION,
    governs: false,
    permissionsIn: async () => permissions,
  });

  /** The org owner governing `here`, never the row's owner. */
  const governor = (): ConnectionViewer => ({
    principal: { kind: "person", actor: person(ctx.user.id) },
    spaceId: here,
    integrationId: INTEGRATION,
    governs: true,
    permissionsIn: async () => GOVERN,
  });

  it("the owner shares once: added, then idempotent, one row attributed to the owner", async () => {
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: memberId });
    const first = await shareConnection({ connectionId: id, spaceId: other, viewer: owner() });
    expect(first.added).toBe(true);
    const second = await shareConnection({ connectionId: id, spaceId: other, viewer: owner() });
    expect(second.added).toBe(false);
    expect(await sharesOf(id)).toEqual([{ spaceId: other, sharedBy: memberId }]);
  });

  it("refuses a governor's share of a colleague's row (403)", async () => {
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: memberId });
    await seedShare(id, here);
    await expect(
      shareConnection({ connectionId: id, spaceId: here, viewer: governor() }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a space-scoped row into another space (400 invalid_share_target)", async () => {
    const id = await seedConnection({ spaceId: here, userId: memberId });
    await expect(
      shareConnection({ connectionId: id, spaceId: other, viewer: owner() }),
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
        viewer: {
          principal: { kind: "delegated", actor, orgId: ctx.orgId, spaceId: here },
          spaceId: here,
          integrationId: INTEGRATION,
          governs: false,
          permissionsIn: async () => CONNECT,
        },
      }),
    ).rejects.toMatchObject({ status: 409, code: "end_user_connection_not_shareable" });
  });

  it("refuses a target where the owner lacks integrations:connect (403)", async () => {
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: memberId });
    await expect(
      shareConnection({ connectionId: id, spaceId: other, viewer: owner(NOTHING) }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await sharesOf(id)).toEqual([]);
  });

  it("a target blocking user connections takes a sharer configuring it there", async () => {
    await seedPlacedPackage(other, INTEGRATION, { blockUserConnections: true });
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: memberId });
    await expect(
      shareConnection({ connectionId: id, spaceId: other, viewer: owner(CONNECT) }),
    ).rejects.toMatchObject({ status: 403, code: "connection_blocked_by_admin" });
    const { added } = await shareConnection({
      connectionId: id,
      spaceId: other,
      viewer: owner(GOVERN),
    });
    expect(added).toBe(true);
  });

  it("a governor withdraws a colleague's share here, never another space's (403)", async () => {
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: memberId });
    await seedShare(id, here);
    await seedShare(id, other);
    await expect(
      unshareConnection({ connectionId: id, spaceId: other, viewer: governor() }),
    ).rejects.toMatchObject({ status: 403 });
    const { removed } = await unshareConnection({
      connectionId: id,
      spaceId: here,
      viewer: governor(),
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
      unshareConnection({ connectionId: id, spaceId: here, viewer: owner() }),
    ).rejects.toMatchObject({ status: 409, code: "connection_pinned" });
    expect((await sharesOf(id)).map((s) => s.spaceId)).toEqual([here]);
  });

  it("withdrawing a share that does not exist reports removed: false", async () => {
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: memberId });
    const result = await unshareConnection({ connectionId: id, spaceId: other, viewer: owner() });
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
      viewer: owner(),
    });

    expect(disabledScheduleIds).toEqual([schedule.id]);
    const [row] = await db
      .select({ enabled: schedules.enabled, reason: schedules.disabledReason })
      .from(schedules)
      .where(eq(schedules.id, schedule.id));
    expect(row).toEqual({ enabled: false, reason: "connection_unshared" });
  });
});
