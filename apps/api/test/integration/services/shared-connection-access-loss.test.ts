// SPDX-License-Identifier: Apache-2.0

/**
 * A connection shared into a space (`shared_space_ids`) powers colleagues' runs there.
 * Every write that takes its owner's access to a target space away must withdraw that
 * share in the same transaction — otherwise a departed member's credentials keep running,
 * and nobody can stop them (unsharing is owner-only for everyone but a governor). Shares
 * into spaces the owner still reaches stay.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestOrg,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedAgent,
  seedPackage,
  seedSchedule,
  seedSpace,
  seedSpaceMember,
} from "../../helpers/seed.ts";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";
import {
  integrationConnections,
  integrationPins,
  runs,
  schedules,
  spaces,
} from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import {
  leaveOrganization,
  provisionMember,
  removeMember,
  updateMemberRole,
} from "../../../src/services/organizations.ts";
import { removeSpaceMember } from "../../../src/services/space-members.ts";
import { updateSpace } from "../../../src/services/spaces.ts";
import { updateConnection } from "../../../src/services/integration-pins-service.ts";
import { triggerScheduledRun } from "../../../src/services/scheduler.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";
import { resolveConnectionsForRun } from "../../../src/services/integration-connection-resolver.ts";
import { presetPermissions } from "../../../src/lib/permissions.ts";
import type { OrgRole } from "@appstrate/core/permissions";

const AGENT = "@lossorg/agent";
const INTEGRATION = "@lossorg/svc";

const agentManifest = {
  name: AGENT,
  version: "1.0.0",
  type: "agent",
  schema_version: "0.2",
  display_name: "Access loss agent",
  dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
  integrations_configuration: { [INTEGRATION]: { tools: ["search"] } },
};

const integrationManifest = localIntegrationManifest({
  name: INTEGRATION,
  serverName: "@lossorg/svc-server",
  version: "1.0.0",
  auths: {
    primary: {
      type: "api_key",
      authorizedUris: ["https://api.example.com/**"],
      credentialFields: ["api_key"],
      delivery: httpHeaderDelivery({ name: "Authorization", prefix: "Bearer ", field: "api_key" }),
    },
  },
  tools_policy: { search: {} },
});

describe("unsharing on access loss", () => {
  let ctx: TestContext;
  const asOwner = () => ({ userId: ctx.user.id, firstPartySession: true });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "lossorg" });
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      homeSpaceId: ctx.defaultSpaceId,
      type: "integration",
      draftManifest: integrationManifest,
    });
  });

  async function addMember(role: OrgRole = "member"): Promise<string> {
    const user = await createTestUser();
    await db.transaction((tx) => provisionMember(tx, ctx.orgId, user.id, role));
    return user.id;
  }

  async function personalSpaceOf(userId: string): Promise<string> {
    const [row] = await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(eq(spaces.ownerUserId, userId));
    return row!.id;
  }

  /**
   * An org-scope connection connected from `spaceId`, shared into it (unless `shared: false`)
   * and into `alsoSharedInto`.
   */
  async function seedConnection(opts: {
    spaceId: string;
    userId: string;
    shared?: boolean;
    alsoSharedInto?: string[];
  }): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION,
        authKey: "primary",
        accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
        orgId: sql`(SELECT org_id FROM spaces WHERE id = ${opts.spaceId})`,
        spaceId: null,
        originSpaceId: opts.spaceId,
        userId: opts.userId,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "k" } }),
        scopesGranted: [],
        sharedSpaceIds: [
          ...(opts.shared === false ? [] : [opts.spaceId]),
          ...(opts.alsoSharedInto ?? []),
        ],
        label: `Connexion ${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  /** The ids among `ids` still shared anywhere, sorted. */
  async function stillShared(ids: string[]): Promise<string[]> {
    const rows = await db
      .select({ id: integrationConnections.id, shares: integrationConnections.sharedSpaceIds })
      .from(integrationConnections)
      .where(inArray(integrationConnections.id, ids));
    return rows
      .filter((row) => row.shares.length > 0)
      .map((row) => row.id)
      .sort();
  }

  async function sharesOf(id: string): Promise<string[]> {
    const [row] = await db
      .select({ shares: integrationConnections.sharedSpaceIds })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, id));
    return [...row!.shares].sort();
  }

  /** The owner's own edit of the share targets, from the account surface. */
  const shareAs = (userId: string, connectionId: string, sharedSpaceIds: string[]) =>
    updateConnection({
      connectionId,
      viewer: {
        actor: { type: "user", id: userId },
        spaceId: null,
        governs: false,
        boundSpaceId: null,
        permissionsIn: async () => presetPermissions("operator"),
      },
      sharedSpaceIds,
    });

  describe("org exit", () => {
    async function seedExitFixture() {
      const member = await addMember();
      const inDefault = await seedConnection({ spaceId: ctx.defaultSpaceId, userId: member });
      const inPersonal = await seedConnection({
        spaceId: await personalSpaceOf(member),
        userId: member,
      });
      const ownerShared = await seedConnection({
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
      });
      // The member's own organization is not the one they leave.
      const { defaultSpaceId: otherOrgSpace } = await createTestOrg(member);
      const otherOrg = await seedConnection({ spaceId: otherOrgSpace, userId: member });
      return {
        member,
        unshared: [inDefault, inPersonal].sort(),
        kept: [ownerShared, otherOrg].sort(),
      };
    }

    it("removal unshares the member's connections in that org, and only those", async () => {
      const f = await seedExitFixture();

      const { unsharedConnectionIds } = await removeMember(ctx.orgId, f.member, asOwner());

      expect([...unsharedConnectionIds].sort()).toEqual(f.unshared);
      expect(await stillShared([...f.unshared, ...f.kept])).toEqual(f.kept);
    });

    it("leaving unshares them the same way", async () => {
      const f = await seedExitFixture();

      const { unsharedConnectionIds } = await leaveOrganization(ctx.orgId, f.member);

      expect([...unsharedConnectionIds].sort()).toEqual(f.unshared);
      expect(await stillShared([...f.unshared, ...f.kept])).toEqual(f.kept);
    });
  });

  it("space member removal unshares only when the member really loses the space", async () => {
    const member = await addMember();
    const closed = await seedSpace({ orgId: ctx.orgId, visibility: "closed" });
    const open = await seedSpace({ orgId: ctx.orgId, visibility: "open", defaultRole: "operator" });
    for (const space of [closed, open]) {
      await seedSpaceMember({ spaceId: space.id, userId: member, presetRole: "builder" });
    }
    const inClosed = await seedConnection({ spaceId: closed.id, userId: member });
    const inOpen = await seedConnection({ spaceId: open.id, userId: member });
    const admin = presetPermissions("admin");

    const closedRemoval = await removeSpaceMember({
      orgId: ctx.orgId,
      space: closed,
      userId: member,
      actorPermissions: admin,
    });
    expect(closedRemoval.unsharedConnectionIds).toEqual([inClosed]);
    // Still reaches the open space through its default role.
    const { accessAfter, unsharedConnectionIds } = await removeSpaceMember({
      orgId: ctx.orgId,
      space: open,
      userId: member,
      actorPermissions: admin,
    });

    expect(accessAfter).not.toBeNull();
    expect(unsharedConnectionIds).toEqual([]);
    expect(await stillShared([inClosed, inOpen])).toEqual([inOpen]);
  });

  it("losing one target withdraws that share only, wherever the connection was made", async () => {
    const member = await addMember();
    const closed = await seedSpace({ orgId: ctx.orgId, visibility: "closed" });
    await seedSpaceMember({ spaceId: closed.id, userId: member, presetRole: "builder" });
    // Connected from the default space, shared into both it and the closed space.
    const conn = await seedConnection({
      spaceId: ctx.defaultSpaceId,
      userId: member,
      alsoSharedInto: [closed.id],
    });

    const removal = await removeSpaceMember({
      orgId: ctx.orgId,
      space: closed,
      userId: member,
      actorPermissions: presetPermissions("admin"),
    });

    expect(removal.unsharedConnectionIds).toEqual([conn]);
    expect(await sharesOf(conn)).toEqual([ctx.defaultSpaceId]);
  });

  it("a demotion unshares where the org role was the only way in", async () => {
    const admin = await addMember("admin");
    // No member row: an admin reaches a closed space by org role alone.
    const closed = await seedSpace({ orgId: ctx.orgId, visibility: "closed" });
    const inClosed = await seedConnection({ spaceId: closed.id, userId: admin });
    const inDefault = await seedConnection({ spaceId: ctx.defaultSpaceId, userId: admin });

    const { unsharedConnectionIds } = await updateMemberRole(ctx.orgId, admin, "member", asOwner());

    expect(unsharedConnectionIds).toEqual([inClosed]);
    expect(await stillShared([inClosed, inDefault])).toEqual([inDefault]);
  });

  it("closing an open space unshares its implicit members' connections", async () => {
    const implicit = await addMember();
    const explicit = await addMember();
    const space = await seedSpace({ orgId: ctx.orgId, visibility: "open" });
    await seedSpaceMember({ spaceId: space.id, userId: explicit, presetRole: "operator" });
    const implicitConn = await seedConnection({ spaceId: space.id, userId: implicit });
    const explicitConn = await seedConnection({ spaceId: space.id, userId: explicit });

    const { unsharedConnectionIds } = await updateSpace(
      ctx.orgId,
      space.id,
      { visibility: "closed" },
      space,
    );

    expect(unsharedConnectionIds).toEqual([implicitConn]);
    expect(await stillShared([implicitConn, explicitConn])).toEqual([explicitConn]);
  });

  // The share-side twin: a share committed after the access loss must not re-share what the
  // loss unshared (the route's own access check ran before the loss).
  it("refuses sharing into a space the owner no longer reaches, naming it", async () => {
    const member = await addMember();
    const closed = await seedSpace({ orgId: ctx.orgId, visibility: "closed" });
    await seedSpaceMember({ spaceId: closed.id, userId: member, presetRole: "builder" });
    const conn = await seedConnection({
      spaceId: ctx.defaultSpaceId,
      userId: member,
      shared: false,
    });
    await removeSpaceMember({
      orgId: ctx.orgId,
      space: closed,
      userId: member,
      actorPermissions: presetPermissions("admin"),
    });

    await expect(shareAs(member, conn, [ctx.defaultSpaceId, closed.id])).rejects.toMatchObject({
      status: 409,
      code: "connection_owner_without_access",
      extensions: { space_id: closed.id },
    });
    expect(await sharesOf(conn)).toEqual([]);
    // Control: the same write naming only a space the owner still reaches.
    await shareAs(member, conn, [ctx.defaultSpaceId]);
    expect(await sharesOf(conn)).toEqual([ctx.defaultSpaceId]);
  });

  // Never refused and never shrunk: the colleague re-picks before re-enabling.
  describe("a colleague's schedule naming the connection", () => {
    beforeEach(async () => {
      await seedAgent({
        id: AGENT,
        orgId: ctx.orgId,
        homeSpaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        draftManifest: agentManifest,
      });
    });

    function scheduleOf(userId: string, connectionId: string, spaceId = ctx.defaultSpaceId) {
      return seedSchedule({
        packageId: AGENT,
        orgId: ctx.orgId,
        spaceId,
        userId,
        nextRunAt: new Date(Date.now() + 3_600_000),
        connectionOverrides: { [INTEGRATION]: [connectionId] },
      });
    }

    async function rowOf(scheduleId: string) {
      const [row] = await db.select().from(schedules).where(eq(schedules.id, scheduleId));
      return row!;
    }

    const unsharedFor = (connectionId: string) => ({
      enabled: false,
      disabledReason: "connection_unshared",
      nextRunAt: null,
      connectionOverrides: { [INTEGRATION]: [connectionId] },
    });

    it("is disabled when the owner unshares, its pin and the owner's own schedule untouched", async () => {
      const member = await addMember();
      const conn = await seedConnection({ spaceId: ctx.defaultSpaceId, userId: member });
      const colleagues = await scheduleOf(ctx.user.id, conn);
      const owners = await scheduleOf(member, conn);
      await db.insert(integrationPins).values({
        spaceId: ctx.defaultSpaceId,
        packageId: AGENT,
        integrationId: INTEGRATION,
        userId: ctx.user.id,
        connectionIds: [conn],
      });

      const { disabledScheduleIds } = await shareAs(member, conn, []);

      expect(disabledScheduleIds).toEqual([colleagues.id]);
      expect(await rowOf(colleagues.id)).toMatchObject(unsharedFor(conn));
      expect(await rowOf(owners.id)).toEqual(owners);
      const pins = await db
        .select({ connectionIds: integrationPins.connectionIds })
        .from(integrationPins);
      expect(pins).toEqual([{ connectionIds: [conn] }]);
      // Its fire is skipped: no failed run.
      expect(await triggerScheduledRun(colleagues.id)).toBeNull();
      expect(await db.select({ id: runs.id }).from(runs)).toEqual([]);
    });

    it("is disabled when the owner leaves the org, whose own schedule is the exit's", async () => {
      const member = await addMember();
      const conn = await seedConnection({ spaceId: ctx.defaultSpaceId, userId: member });
      const colleagues = await scheduleOf(ctx.user.id, conn);
      const owners = await scheduleOf(member, conn);

      await removeMember(ctx.orgId, member, asOwner());

      expect(await rowOf(colleagues.id)).toMatchObject(unsharedFor(conn));
      expect(await rowOf(owners.id)).toMatchObject({
        enabled: false,
        disabledReason: "actor_left_org",
      });
    });

    it("is disabled, and reported for its job, when the owner is removed from the space", async () => {
      const member = await addMember();
      const closed = await seedSpace({ orgId: ctx.orgId, visibility: "closed" });
      await seedSpaceMember({ spaceId: closed.id, userId: member, presetRole: "builder" });
      const conn = await seedConnection({ spaceId: closed.id, userId: member });
      const colleagues = await scheduleOf(ctx.user.id, conn, closed.id);

      const { disabledScheduleIds } = await removeSpaceMember({
        orgId: ctx.orgId,
        space: closed,
        userId: member,
        actorPermissions: presetPermissions("admin"),
      });

      expect(disabledScheduleIds).toEqual([colleagues.id]);
      expect(await rowOf(colleagues.id)).toMatchObject(unsharedFor(conn));
    });

    it("is kept in a target the owner still reaches when another target is lost", async () => {
      const member = await addMember();
      const closed = await seedSpace({ orgId: ctx.orgId, visibility: "closed" });
      await seedSpaceMember({ spaceId: closed.id, userId: member, presetRole: "builder" });
      const conn = await seedConnection({
        spaceId: ctx.defaultSpaceId,
        userId: member,
        alsoSharedInto: [closed.id],
      });
      const inClosed = await scheduleOf(ctx.user.id, conn, closed.id);
      const inDefault = await scheduleOf(ctx.user.id, conn);

      const { disabledScheduleIds } = await removeSpaceMember({
        orgId: ctx.orgId,
        space: closed,
        userId: member,
        actorPermissions: presetPermissions("admin"),
      });

      expect(disabledScheduleIds).toEqual([inClosed.id]);
      expect(await rowOf(inClosed.id)).toMatchObject(unsharedFor(conn));
      expect(await rowOf(inDefault.id)).toEqual(inDefault);
    });

    it("is disabled, and reported for its job, when the owner's open space closes", async () => {
      const implicit = await addMember();
      const space = await seedSpace({ orgId: ctx.orgId, visibility: "open" });
      const conn = await seedConnection({ spaceId: space.id, userId: implicit });
      const colleagues = await scheduleOf(ctx.user.id, conn, space.id);

      const { disabledScheduleIds } = await updateSpace(
        ctx.orgId,
        space.id,
        { visibility: "closed" },
        space,
      );

      expect(disabledScheduleIds).toEqual([colleagues.id]);
      expect(await rowOf(colleagues.id)).toMatchObject(unsharedFor(conn));
    });

    it("is disabled when the owner's demotion loses the space", async () => {
      const admin = await addMember("admin");
      // No member row: an admin reaches a closed space by org role alone.
      const closed = await seedSpace({ orgId: ctx.orgId, visibility: "closed" });
      const conn = await seedConnection({ spaceId: closed.id, userId: admin });
      const colleagues = await scheduleOf(ctx.user.id, conn, closed.id);

      await updateMemberRole(ctx.orgId, admin, "member", asOwner());

      expect(await rowOf(colleagues.id)).toMatchObject(unsharedFor(conn));
    });
  });

  it("an admin pin on a departed member's connection fails loudly at resolution", async () => {
    await seedAgent({
      id: AGENT,
      orgId: ctx.orgId,
      homeSpaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      draftManifest: agentManifest,
    });
    const scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    await activatePackage(scope, AGENT);
    await activatePackage(scope, INTEGRATION);
    const member = await addMember();
    const pinned = await seedConnection({ spaceId: ctx.defaultSpaceId, userId: member });
    await db.insert(integrationPins).values({
      spaceId: ctx.defaultSpaceId,
      packageId: AGENT,
      integrationId: INTEGRATION,
      userId: null,
      connectionIds: [pinned],
    });
    const resolve = () =>
      resolveConnectionsForRun({
        agentManifest,
        packageId: AGENT,
        actor: { type: "user", id: ctx.user.id },
        scope,
      });

    const before = await resolve();
    expect(before.errors).toEqual([]);
    expect(before.resolved[INTEGRATION]?.map((c) => c.connectionId)).toEqual([pinned]);

    await removeMember(ctx.orgId, member, asOwner());

    const { errors } = await resolve();
    expect(errors.map((e) => e.code)).toEqual(["pinned_connection_unavailable"]);
  });
});
