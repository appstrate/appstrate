// SPDX-License-Identifier: Apache-2.0

/**
 * `shareConnection` / `unshareConnection`: one `integration_connection_shares` row per
 * (connection, space). Only the owner shares; the owner or a governor of the request space
 * withdraws. The service enforces team-only targets, no end-user sharing and confinement of
 * space-scoped rows to their own space.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db, truncateAll } from "../../helpers/db.ts";
import { seedShares, testCaller } from "../../helpers/connection-shares.ts";
import {
  addOrgMember,
  authHeaders,
  createTestContext,
  createTestOrg,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedEndUser,
  seedPackage,
  seedSpacePackage,
  seedSchedule,
  seedSpace,
} from "../../helpers/seed.ts";
import {
  auditEvents,
  integrationConnectionShares,
  organizationMembers,
  integrationConnections,
  integrationPins,
  schedules,
} from "@appstrate/db/schema";
import type { Permission } from "../../../src/lib/permissions.ts";
import type { Actor } from "../../../src/lib/actor.ts";
import {
  setConnectionShareAllSpaces,
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
        canShareAllSpaces: () => true,
        permissionsIn: async () => GOVERN,
      },
    );

  it("shares all team spaces until a withdrawal selects specific spaces", async () => {
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: ctx.user.id });
    const input = { connectionId: id, integrationId: INTEGRATION, caller: orgOwner() };
    const app = await getTestApp();
    const response = await app.request("/api/me/connections/" + id + "/shares", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ share_all_spaces: true }),
    });
    expect(response.status).toBe(204);
    expect((await sharesOf(id)).map((s) => s.spaceId).sort()).toEqual([here, other].sort());
    const future = await createSpace(ctx.orgId, { name: "Future team" }, ctx.user.id);
    expect((await sharesOf(id)).some((s) => s.spaceId === future.id)).toBe(true);
    // Existing unshare/pin/schedule behavior stays the authority, also with all-spaces sharing on.
    await unshareConnection({ ...input, spaceId: other });
    const specificFuture = await createSpace(ctx.orgId, { name: "Another team" });
    expect((await sharesOf(id)).some((s) => s.spaceId === other)).toBe(false);
    expect((await sharesOf(id)).some((s) => s.spaceId === specificFuture.id)).toBe(false);
    const [specific] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, id));
    expect(specific!.shareAllSpaces).toBe(false);
    const before = await sharesOf(id);
    await setConnectionShareAllSpaces({ ...input, enabled: false });
    const excludedFuture = await createSpace(ctx.orgId, { name: "Not auto-shared" });
    expect(await sharesOf(id)).toEqual(before);
    expect((await sharesOf(id)).some((s) => s.spaceId === excludedFuture.id)).toBe(false);
  });

  it("a governor's withdrawal selects specific spaces and never shares new spaces implicitly", async () => {
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: memberId });
    await db
      .update(organizationMembers)
      .set({ role: "admin" })
      .where(
        and(eq(organizationMembers.orgId, ctx.orgId), eq(organizationMembers.userId, memberId)),
      );
    await setConnectionShareAllSpaces({
      connectionId: id,
      integrationId: INTEGRATION,
      caller: { ...owner(GOVERN), canShareAllSpaces: () => true },
      enabled: true,
    });
    const { connection, removed } = await unshareConnection({
      connectionId: id,
      integrationId: INTEGRATION,
      caller: governor(),
      spaceId: here,
    });
    expect(removed).toBe(true);
    expect(connection.shareAllSpaces).toBe(false);
    expect((await sharesOf(id)).map((s) => s.spaceId)).toEqual([other]);
    const future = await createSpace(ctx.orgId, { name: "Unselected future" });
    expect((await sharesOf(id)).some((s) => s.spaceId === future.id)).toBe(false);
  });

  it("refuses sharing into a personal space through either route and omits it from targets", async () => {
    const personal = await seedSpace({
      orgId: ctx.orgId,
      name: "My private space",
      ownerUserId: ctx.user.id,
      visibility: "private",
    });
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: ctx.user.id });
    const app = await getTestApp();
    for (const path of [
      `/api/me/connections/${id}/shares/${personal.id}`,
      `/api/integrations/${INTEGRATION}/connections/${id}/shares/${personal.id}`,
    ]) {
      const response = await app.request(path, { method: "PUT", headers: authHeaders(ctx) });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_share_target" });
    }
    for (const path of ["/api/me/connections", `/api/integrations/${INTEGRATION}/connections`]) {
      const response = await app.request(path, { headers: authHeaders(ctx) });
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain(personal.id);
    }
    expect(await sharesOf(id)).toEqual([]);
  });

  it("a withdrawal with nothing to remove preserves all-space mode", async () => {
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: ctx.user.id });
    const input = { connectionId: id, integrationId: INTEGRATION, caller: orgOwner() };
    await setConnectionShareAllSpaces({ ...input, enabled: true });
    const personal = await seedSpace({
      orgId: ctx.orgId,
      ownerUserId: ctx.user.id,
      visibility: "private",
    });
    const before = (
      await db.select().from(integrationConnections).where(eq(integrationConnections.id, id))
    )[0]!;
    const result = await unshareConnection({ ...input, spaceId: personal.id });
    expect(result.removed).toBe(false);
    expect(result.connection.shareAllSpaces).toBe(true);
    expect(result.connection.updatedAt).toEqual(before.updatedAt);
  });

  it("explicitly re-enabling all-space sharing restores individual withdrawals", async () => {
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: ctx.user.id });
    const input = { connectionId: id, integrationId: INTEGRATION, caller: orgOwner() };
    await setConnectionShareAllSpaces({ ...input, enabled: true });
    await unshareConnection({ ...input, spaceId: other });
    await setConnectionShareAllSpaces({ ...input, enabled: false });
    expect((await sharesOf(id)).map((s) => s.spaceId)).toEqual([here]);
    await setConnectionShareAllSpaces({ ...input, enabled: true });
    expect((await sharesOf(id)).map((s) => s.spaceId).sort()).toEqual([here, other].sort());
  });

  it("unchanged policy requests do not touch the row or add audit events", async () => {
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: ctx.user.id });
    const app = await getTestApp();
    const put = (enabled: boolean) =>
      app.request(`/api/me/connections/${id}/shares`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ share_all_spaces: enabled }),
      });
    for (const enabled of [true, false]) {
      expect((await put(enabled)).status).toBe(204);
      const [before] = await db
        .select()
        .from(integrationConnections)
        .where(eq(integrationConnections.id, id));
      const auditsBefore = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.resourceId, id));
      expect((await put(enabled)).status).toBe(204);
      const [after] = await db
        .select()
        .from(integrationConnections)
        .where(eq(integrationConnections.id, id));
      expect(after!.updatedAt).toEqual(before!.updatedAt);
      expect(await db.select().from(auditEvents).where(eq(auditEvents.resourceId, id))).toEqual(
        auditsBefore,
      );
    }
  });

  it("role preview refuses global consent on both doors and hides the offered action", async () => {
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: ctx.user.id });
    const app = await getTestApp();
    await seedSpace({ orgId: ctx.orgId, name: "Private team", visibility: "private" });
    for (const role of ["member", "guest"]) {
      const headers = {
        ...authHeaders(ctx),
        "Content-Type": "application/json",
        "X-View-As": `org_role=${role}`,
      };
      for (const path of [
        `/api/me/connections/${id}/shares`,
        `/api/integrations/${INTEGRATION}/connections/${id}/shares`,
      ]) {
        const response = await app.request(path, {
          method: "PUT",
          headers,
          body: JSON.stringify({ share_all_spaces: true }),
        });
        expect(response.status).toBe(403);
        expect(response.headers.get("X-View-As-Active")).toBe("1");
      }
      for (const path of ["/api/me/connections", `/api/integrations/${INTEGRATION}/connections`]) {
        const response = await app.request(path, { headers });
        expect(response.status).toBe(
          role === "guest" && path !== "/api/me/connections" ? 403 : 200,
        );
        // The action, not the `share_all_spaces` field every owner row carries.
        expect(await response.text()).not.toMatch(/"allowed_actions":\[[^\]]*"share_all_spaces"/);
      }
    }
    expect(await sharesOf(id)).toEqual([]);
    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, id));
    expect(row!.shareAllSpaces).toBe(false);
    const response = await app.request(`/api/me/connections/${id}/shares`, {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ share_all_spaces: true }),
    });
    expect(response.status).toBe(204);
  });

  it("account listing applies preview only to its selected organization", async () => {
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: ctx.user.id });
    const elsewhere = await createTestOrg(ctx.user.id);
    const otherId = await seedConnection({
      spaceId: elsewhere.defaultSpaceId,
      orgScope: true,
      userId: ctx.user.id,
    });
    const app = await getTestApp();
    const response = await app.request("/api/me/connections", {
      headers: { ...authHeaders(ctx), "X-View-As": "org_role=member" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-View-As-Active")).toBe("1");
    const body = z
      .object({
        data: z.array(
          z.object({
            connections: z.array(
              z.object({ connection_id: z.string(), allowed_actions: z.array(z.string()) }),
            ),
          }),
        ),
      })
      .parse(await response.json());
    const rows = body.data.flatMap((group) => group.connections);
    expect(rows.find((row) => row.connection_id === id)!.allowed_actions).not.toContain(
      "share_all_spaces",
    );
    expect(rows.find((row) => row.connection_id === otherId)!.allowed_actions).toContain(
      "share_all_spaces",
    );
  });

  it("refuses a member, another owner, a space-scoped row and a delegated credential", async () => {
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: memberId });
    for (const [caller, status] of [
      [owner(GOVERN), 403],
      [orgOwner(), 404],
      [
        testCaller(
          {
            kind: "delegated",
            actor: person(memberId),
            orgId: ctx.orgId,
            spaceId: null,
          },
          { canShareAllSpaces: () => true },
        ),
        403,
      ],
    ] as const) {
      await expect(
        setConnectionShareAllSpaces({
          connectionId: id,
          integrationId: INTEGRATION,
          caller,
          enabled: true,
        }),
      ).rejects.toMatchObject({ status });
    }
    const scoped = await seedConnection({ spaceId: here, userId: ctx.user.id });
    await expect(
      setConnectionShareAllSpaces({
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
    await setConnectionShareAllSpaces({
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

  it("revokes all-spaces sharing when the owner loses org administration", async () => {
    await db
      .update(organizationMembers)
      .set({ role: "admin" })
      .where(
        and(eq(organizationMembers.orgId, ctx.orgId), eq(organizationMembers.userId, memberId)),
      );
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: memberId });
    await setConnectionShareAllSpaces({
      connectionId: id,
      integrationId: INTEGRATION,
      caller: { ...owner(GOVERN), canShareAllSpaces: () => true },
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
    expect(row!.shareAllSpaces).toBe(false);
    const future = await createSpace(ctx.orgId, { name: "After demotion" });
    expect((await sharesOf(id)).some((s) => s.spaceId === future.id)).toBe(false);
  });

  it("clears all-spaces consent on departure so reinviting an admin cannot silently restore it", async () => {
    await db
      .update(organizationMembers)
      .set({ role: "admin" })
      .where(
        and(eq(organizationMembers.orgId, ctx.orgId), eq(organizationMembers.userId, memberId)),
      );
    const id = await seedConnection({ spaceId: here, orgScope: true, userId: memberId });
    await setConnectionShareAllSpaces({
      connectionId: id,
      integrationId: INTEGRATION,
      caller: { ...owner(GOVERN), canShareAllSpaces: () => true },
      enabled: true,
    });
    await removeMember(ctx.orgId, memberId, { userId: ctx.user.id, firstPartySession: true });
    await addOrgMember(ctx.orgId, memberId, "admin");
    await createSpace(ctx.orgId, { name: "After re-invite" });
    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, id));
    expect(row!.shareAllSpaces).toBe(false);
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
    await seedSpacePackage(other, INTEGRATION, { blockUserConnections: true });
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
    await db
      .update(integrationConnections)
      .set({ shareAllSpaces: true })
      .where(eq(integrationConnections.id, id));
    await seedShare(id, other);
    await expect(
      unshareConnection({
        connectionId: id,
        spaceId: here,
        integrationId: INTEGRATION,
        caller: owner(),
      }),
    ).rejects.toMatchObject({ status: 409, code: "connection_pinned" });
    expect((await sharesOf(id)).map((s) => s.spaceId).sort()).toEqual([here, other].sort());
    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, id));
    expect(row!.shareAllSpaces).toBe(true);
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
