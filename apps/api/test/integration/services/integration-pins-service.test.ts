// SPDX-License-Identifier: Apache-2.0

/**
 * Service-level tests for the DB-querying access/ownership logic in
 * integration-pins-service. The resolver's cascade is unit-tested in
 * integration-connection-resolver with hand-built candidate arrays; this
 * file exercises the real Drizzle queries those candidates come from:
 *
 *   - validatePinTargets — cross-space / cross-integration / sharing /
 *     ownership rejection (the gate every pin write passes through)
 *   - listAccessibleConnections — own ∪ shared into the space, deduped,
 *     scoped to (space, integration), filtered by actor
 *   - updateConnection — label and per-target share edits, owner vs governor
 *   - loadConnectionOwnership — owner projection used by RBAC checks
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestOrg,
  createTestUser,
  addOrgMember,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedEndUser,
  seedPackage,
  seedSchedule,
  seedSpace,
  seedSpacePackage,
} from "../../helpers/seed.ts";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  integrationConnections,
  integrationOauthClients,
  integrationPins,
  runs,
  schedules,
} from "@appstrate/db/schema";
import type { SpaceScope } from "../../../src/lib/scope.ts";
import {
  validatePinTargets,
  listAccessibleConnections,
  listAgentsConsumingIntegration,
  loadConnectionOwnership,
  listIntegrationPins,
  upsertIntegrationPin,
  upsertMemberPin,
  updateConnection,
  type ConnectionViewer,
} from "../../../src/services/integration-pins-service.ts";
import {
  deleteOwnConnection,
  deleteIntegrationOAuthClient,
} from "../../../src/services/integration-connections.ts";
import { upsertOrgDefault } from "../../../src/services/integration-org-defaults-service.ts";
import { triggerScheduledRun } from "../../../src/services/scheduler.ts";

const INTEGRATION = "@official/gmail";
const OTHER_INTEGRATION = "@official/clickup";

/**
 * A connection serving `spaceId` — of org scope connected from it when `orgScope`, else scoped to
 * it — shared into it when `shared`, else into `sharedSpaceIds`.
 */
async function seedConnection(opts: {
  integrationId?: string;
  spaceId: string;
  orgScope?: boolean;
  authKey?: string;
  accountId?: string;
  userId?: string | null;
  endUserId?: string | null;
  shared?: boolean;
  sharedSpaceIds?: string[];
  label?: string;
}): Promise<string> {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      integrationId: opts.integrationId ?? INTEGRATION,
      authKey: opts.authKey ?? "google",
      accountId: opts.accountId ?? `acct-${crypto.randomUUID().slice(0, 8)}`,
      orgId: sql`(SELECT org_id FROM spaces WHERE id = ${opts.spaceId})`,
      spaceId: opts.orgScope ? null : opts.spaceId,
      originSpaceId: opts.orgScope ? opts.spaceId : null,
      userId: opts.userId ?? null,
      endUserId: opts.endUserId ?? null,
      credentialsEncrypted: "x",
      scopesGranted: ["openid", "email"],
      sharedSpaceIds: opts.sharedSpaceIds ?? (opts.shared ? [opts.spaceId] : []),
      label: opts.label ?? `Connexion ${crypto.randomUUID().slice(0, 8)}`,
    })
    .returning({ id: integrationConnections.id });
  return row!.id;
}

async function sharesOf(id: string): Promise<string[]> {
  const [row] = await db
    .select({ sharedSpaceIds: integrationConnections.sharedSpaceIds })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, id));
  return row!.sharedSpaceIds;
}

describe("integration-pins-service — DB access/ownership", () => {
  let ctx: TestContext;
  let scope: SpaceScope;
  let memberId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "pinsorg" });
    scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    await seedPackage({ id: INTEGRATION, orgId: ctx.orgId, type: "integration", source: "local" });
    await seedPackage({
      id: OTHER_INTEGRATION,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
    });
    const member = await createTestUser();
    memberId = member.id;
    await addOrgMember(ctx.orgId, member.id);
  });

  const viewer = (id: string, governs = false): ConnectionViewer => ({
    actor: { type: "user", id },
    spaceId: scope.spaceId,
    governs,
  });
  const authority = () => ({ kind: "bound" as const, orgId: scope.orgId, spaceId: scope.spaceId });

  describe("validatePinTargets", () => {
    /** The refusal with the probed id masked — what a caller could compare across ids. */
    async function refusal(
      ids: string[],
      probed: string,
      opts: Parameters<typeof validatePinTargets>[3],
    ): Promise<{ status: number; code: string; message: string }> {
      try {
        await validatePinTargets(scope, INTEGRATION, ids, opts);
      } catch (err) {
        const e = err as { status: number; code: string; message: string };
        return { status: e.status, code: e.code, message: e.message.replace(probed, "<id>") };
      }
      throw new Error(`validatePinTargets accepted ${ids.join(",")}`);
    }

    // One answer for every id the caller may not pin, so a uuid cannot be probed.
    it("refuses an unknown id, another space, another integration and a private row alike", async () => {
      const otherSpace = await seedSpace({ orgId: ctx.orgId, name: "Other" });
      const inOtherSpace = await seedConnection({
        spaceId: otherSpace.id,
        userId: memberId,
        shared: true,
      });
      const ofOtherIntegration = await seedConnection({
        integrationId: OTHER_INTEGRATION,
        spaceId: scope.spaceId,
        userId: memberId,
        shared: true,
      });
      const privateRow = await seedConnection({
        spaceId: scope.spaceId,
        userId: memberId,
        shared: false,
      });
      const ids = [crypto.randomUUID(), inOtherSpace, ofOtherIntegration, privateRow];

      for (const opts of [{}, { allowOwnedBy: ctx.user.id }]) {
        const answers = await Promise.all(ids.map((id) => refusal([id], id, opts)));
        expect(answers[0]).toMatchObject({ status: 404, code: "not_found" });
        for (const answer of answers) expect(answer).toEqual(answers[0]!);
      }
    });

    it("names the refused id of a set whose other ids are pinnable", async () => {
      const shared = await seedConnection({
        spaceId: scope.spaceId,
        userId: memberId,
        shared: true,
      });
      const unknown = crypto.randomUUID();
      const answer = await refusal([shared, unknown], unknown, {});
      expect(answer.message).toContain("<id>");
      expect(answer).toEqual(await refusal([unknown], unknown, {}));
    });

    it("accepts a set of shared connections under the shared-only default", async () => {
      const ids = [
        await seedConnection({ spaceId: scope.spaceId, userId: memberId, shared: true }),
        await seedConnection({ spaceId: scope.spaceId, userId: ctx.user.id, shared: true }),
      ];
      await validatePinTargets(scope, INTEGRATION, ids, {});
    });

    it("refuses the caller's own private row under the shared-only default, with the same answer", async () => {
      const own = await seedConnection({ spaceId: scope.spaceId, userId: ctx.user.id });
      const unknown = crypto.randomUUID();
      expect(await refusal([own], own, {})).toEqual(await refusal([unknown], unknown, {}));
    });

    it("accepts allowOwnedBy for the caller's own row beside a shared one", async () => {
      const ids = [
        await seedConnection({ spaceId: scope.spaceId, userId: ctx.user.id }),
        await seedConnection({ spaceId: scope.spaceId, userId: memberId, shared: true }),
      ];
      await validatePinTargets(scope, INTEGRATION, ids, { allowOwnedBy: ctx.user.id });
    });
  });

  describe("listAccessibleConnections", () => {
    it("returns the actor's own connections plus org-shared, deduped", async () => {
      const own = await seedConnection({ spaceId: scope.spaceId, userId: ctx.user.id });
      const sharedByMember = await seedConnection({
        spaceId: scope.spaceId,
        userId: memberId,
        shared: true,
      });
      // Owned AND shared by the caller — must appear exactly once.
      const ownAndShared = await seedConnection({
        spaceId: scope.spaceId,
        userId: ctx.user.id,
        shared: true,
      });
      // Another member's private connection — must NOT be visible.
      await seedConnection({ spaceId: scope.spaceId, userId: memberId });

      const list = await listAccessibleConnections(scope, INTEGRATION, {
        type: "user",
        id: ctx.user.id,
      });
      const ids = list.map((c) => c.id);
      expect(ids).toContain(own);
      expect(ids).toContain(sharedByMember);
      expect(ids).toContain(ownAndShared);
      expect(ids.filter((i) => i === ownAndShared)).toHaveLength(1);
      expect(list).toHaveLength(3);
    });

    it("excludes connections from other integrations and other spaces", async () => {
      const visible = await seedConnection({
        spaceId: scope.spaceId,
        userId: ctx.user.id,
      });
      await seedConnection({
        integrationId: OTHER_INTEGRATION,
        spaceId: scope.spaceId,
        userId: ctx.user.id,
      });
      const otherSpace = await seedSpace({ orgId: ctx.orgId, name: "Other" });
      await seedConnection({
        spaceId: otherSpace.id,
        userId: ctx.user.id,
        shared: true,
      });

      const list = await listAccessibleConnections(scope, INTEGRATION, {
        type: "user",
        id: ctx.user.id,
      });
      expect(list.map((c) => c.id)).toEqual([visible]);
    });
  });

  // ─── the ONE activation rule, on the two readers that used to take a
  //     `space_packages` row as the answer ────────────────────────────────
  describe("activation — a row is not the answer", () => {
    function agentManifest(id: string): Record<string, unknown> {
      return {
        name: id,
        version: "1.0.0",
        type: "agent",
        schema_version: "0.2",
        display_name: `Agent ${id}`,
        dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
      };
    }

    /** An agent declaring INTEGRATION, homed where told, with a row HERE. */
    async function seedConsumingAgent(
      id: string,
      opts: { homeSpaceId: string; enabled?: boolean },
    ): Promise<void> {
      await seedPackage({
        id,
        orgId: ctx.orgId,
        type: "agent",
        homeSpaceId: opts.homeSpaceId,
        draftManifest: agentManifest(id),
      });
      await seedSpacePackage(scope.spaceId, id, { enabled: opts.enabled ?? true });
    }

    it("listAgentsConsumingIntegration lists only the agents this space RUNS", async () => {
      const elsewhere = await seedSpace({ orgId: ctx.orgId, name: "Elsewhere" });
      await seedConsumingAgent("@pinsorg/runs-here", { homeSpaceId: scope.spaceId });
      // Switched OFF: the row is the space's decision, and it says no.
      await seedConsumingAgent("@pinsorg/switched-off", {
        homeSpaceId: scope.spaceId,
        enabled: false,
      });
      // ORPHAN: a row here, but homed elsewhere and offered to nobody.
      await seedConsumingAgent("@pinsorg/orphan", { homeSpaceId: elsewhere.id });

      const listed = await listAgentsConsumingIntegration(scope, INTEGRATION);
      expect(listed.map((a) => a.agent_package_id)).toEqual(["@pinsorg/runs-here"]);
    });

    it("a pin is refused for an agent this space does not RUN", async () => {
      const connectionId = await seedConnection({
        spaceId: scope.spaceId,
        userId: memberId,
        shared: true,
      });
      await seedConsumingAgent("@pinsorg/pin-off", {
        homeSpaceId: scope.spaceId,
        enabled: false,
      });

      await expect(
        upsertIntegrationPin(scope, INTEGRATION, {
          agentPackageId: "@pinsorg/pin-off",
          connectionIds: [connectionId],
          createdBy: ctx.user.id,
        }),
      ).rejects.toThrow(/not active in this space/i);

      // Same agent, switched ON — the pin lands.
      await seedSpacePackage(scope.spaceId, "@pinsorg/pin-off", { enabled: true });
      const { pin } = await upsertIntegrationPin(scope, INTEGRATION, {
        agentPackageId: "@pinsorg/pin-off",
        connectionIds: [connectionId],
        createdBy: ctx.user.id,
      });
      expect(pin.connection_ids).toEqual([connectionId]);
    });
  });

  describe("pin sets", () => {
    const AGENT = "@pinsorg/set-agent";

    async function seedSharedConnections(n: number): Promise<string[]> {
      const ids: string[] = [];
      for (let i = 0; i < n; i += 1) {
        ids.push(await seedConnection({ spaceId: scope.spaceId, userId: memberId, shared: true }));
      }
      return ids.sort();
    }

    /** A custom OAuth client of the space, marked as the minter of `connectionIds`; returns its id. */
    async function seedClientMinting(connectionIds: string[]): Promise<string> {
      const [client] = await db
        .insert(integrationOauthClients)
        .values({
          orgId: scope.orgId,
          spaceId: scope.spaceId,
          integrationId: INTEGRATION,
          authKey: "google",
          clientId: "byo-app",
          clientSecretEncrypted: "x",
        })
        .returning({ id: integrationOauthClients.id });
      await db
        .update(integrationConnections)
        .set({ clientRef: client!.id })
        .where(inArray(integrationConnections.id, connectionIds));
      return client!.id;
    }

    beforeEach(async () => {
      await seedPackage({
        id: AGENT,
        orgId: ctx.orgId,
        type: "agent",
        homeSpaceId: scope.spaceId,
        draftManifest: {
          type: "agent",
          schema_version: "0.1",
          name: AGENT,
          version: "1.0.0",
          display_name: "Set agent",
          prompt: "x",
          dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
        },
      });
      await seedSpacePackage(scope.spaceId, AGENT, { enabled: true });
    });

    it("pins N connections as one row, in the caller's order", async () => {
      const ids = await seedSharedConnections(3);
      const { pin } = await upsertIntegrationPin(scope, INTEGRATION, {
        agentPackageId: AGENT,
        connectionIds: ids,
        createdBy: ctx.user.id,
      });
      expect(pin.connection_ids).toEqual(ids);

      const listed = await listIntegrationPins(scope, INTEGRATION);
      expect(listed).toHaveLength(1);
      expect(listed[0]!.connection_ids).toEqual(ids);
    });

    it("a second write REPLACES the set rather than merging into it", async () => {
      const ids = await seedSharedConnections(3);
      const first = await upsertIntegrationPin(scope, INTEGRATION, {
        agentPackageId: AGENT,
        connectionIds: ids,
        createdBy: ctx.user.id,
      });
      expect(first.previous).toBeNull();
      const second = await upsertIntegrationPin(scope, INTEGRATION, {
        agentPackageId: AGENT,
        connectionIds: [ids[2]!],
        createdBy: ctx.user.id,
      });
      expect(second.previous).toEqual(ids);
      const listed = await listIntegrationPins(scope, INTEGRATION);
      expect(listed).toHaveLength(1);
      expect(listed[0]!.connection_ids).toEqual([ids[2]!]);
      expect(listed[0]!.connection_ids).not.toContain(ids[0]!);
    });

    it("echoes what the next read returns, in the caller's order", async () => {
      const ids = await seedSharedConnections(2);
      const reversed = [...ids].reverse();
      const { pin } = await upsertIntegrationPin(scope, INTEGRATION, {
        agentPackageId: AGENT,
        connectionIds: reversed.map((id) => id.toUpperCase()),
        createdBy: ctx.user.id,
      });
      expect(pin.connection_ids).toEqual(reversed);
      expect((await listIntegrationPins(scope, INTEGRATION))[0]!.connection_ids).toEqual(
        pin.connection_ids,
      );
    });

    it("deleting a pinned connection leaves its id in the set — the pin never shrinks", async () => {
      const ids = await seedSharedConnections(2);
      await upsertIntegrationPin(scope, INTEGRATION, {
        agentPackageId: AGENT,
        connectionIds: ids,
        createdBy: ctx.user.id,
      });
      await db.delete(integrationConnections).where(eq(integrationConnections.id, ids[1]!));
      expect((await listIntegrationPins(scope, INTEGRATION))[0]!.connection_ids).toEqual(ids);
    });

    it("refuses to unshare ANY member of a pinned set (409 connection_pinned)", async () => {
      const ids = await seedSharedConnections(2);
      await upsertIntegrationPin(scope, INTEGRATION, {
        agentPackageId: AGENT,
        connectionIds: ids,
        createdBy: ctx.user.id,
      });
      await expect(
        updateConnection({ connectionId: ids[1]!, viewer: viewer(memberId), sharedSpaceIds: [] }),
      ).rejects.toMatchObject({ status: 409, code: "connection_pinned" });
      // Control: a shared connection outside the set unshares freely.
      const [outside] = await seedSharedConnections(1);
      const { connection } = await updateConnection({
        connectionId: outside!,
        viewer: viewer(memberId),
        sharedSpaceIds: [],
      });
      expect(connection.sharedSpaceIds).toEqual([]);
    });

    it("returns the written pin even when the row is deleted right after the write", async () => {
      // An AFTER trigger stands in for a concurrent DELETE landing between the
      // upsert and any follow-up read: the summary must come from the write.
      const ids = await seedSharedConnections(1);
      await db.execute(sql`
        CREATE OR REPLACE FUNCTION pin_vanish_fn() RETURNS trigger AS $$
        BEGIN
          DELETE FROM integration_pins WHERE id = NEW.id;
          RETURN NULL;
        END $$ LANGUAGE plpgsql`);
      await db.execute(sql`
        CREATE TRIGGER pin_vanish_trg AFTER INSERT OR UPDATE ON integration_pins
        FOR EACH ROW EXECUTE FUNCTION pin_vanish_fn()`);
      try {
        const { pin } = await upsertIntegrationPin(scope, INTEGRATION, {
          agentPackageId: AGENT,
          connectionIds: ids,
          createdBy: ctx.user.id,
        });
        expect(pin.connection_ids).toEqual(ids);
        expect(Number.isNaN(Date.parse(pin.createdAt))).toBe(false);
      } finally {
        await db.execute(sql`DROP TRIGGER IF EXISTS pin_vanish_trg ON integration_pins`);
        await db.execute(sql`DROP FUNCTION IF EXISTS pin_vanish_fn()`);
      }
    });

    it("refuses to delete ANY member of a pinned set (409 connection_pinned)", async () => {
      const ids = await seedSharedConnections(2);
      await upsertIntegrationPin(scope, INTEGRATION, {
        agentPackageId: AGENT,
        connectionIds: ids,
        createdBy: ctx.user.id,
      });
      const owner = { type: "user" as const, id: memberId };
      await expect(deleteOwnConnection(owner, ids[1]!, authority())).rejects.toMatchObject({
        status: 409,
        code: "connection_pinned",
      });
      const [still] = await db
        .select({ id: integrationConnections.id })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, ids[1]!));
      expect(still?.id).toBe(ids[1]);
      // Control: a connection outside every set deletes freely.
      const [outside] = await seedSharedConnections(1);
      await deleteOwnConnection(owner, outside!, authority());
    });

    it("a member pin — the owner's own or a colleague's — blocks neither delete nor unshare", async () => {
      const [ownPinned, colleaguePinned, toUnshare] = await seedSharedConnections(3);
      await upsertMemberPin(scope, {
        agentPackageId: AGENT,
        integrationId: INTEGRATION,
        connectionIds: [ownPinned!],
        userId: memberId,
      });
      for (const id of [colleaguePinned!, toUnshare!]) {
        await upsertMemberPin(scope, {
          agentPackageId: AGENT,
          integrationId: INTEGRATION,
          connectionIds: [id],
          userId: ctx.user.id,
        });
      }
      const owner = { type: "user" as const, id: memberId };
      await deleteOwnConnection(owner, ownPinned!, authority());
      await deleteOwnConnection(owner, colleaguePinned!, authority());
      const { connection } = await updateConnection({
        connectionId: toUnshare!,
        viewer: viewer(memberId),
        sharedSpaceIds: [],
      });
      expect(connection.sharedSpaceIds).toEqual([]);
      const left = await db
        .select({ id: integrationConnections.id })
        .from(integrationConnections)
        .where(inArray(integrationConnections.id, [ownPinned!, colleaguePinned!]));
      expect(left).toEqual([]);
    });

    describe("deleting a connection its owner pinned", () => {
      const OTHER_AGENT = "@pinsorg/other-agent";
      const owner = () => ({ type: "user" as const, id: memberId });

      async function memberPinSet(userId: string, agent = AGENT): Promise<string[] | null> {
        const [row] = await db
          .select({ connectionIds: integrationPins.connectionIds })
          .from(integrationPins)
          .where(and(eq(integrationPins.userId, userId), eq(integrationPins.packageId, agent)));
        return row?.connectionIds ?? null;
      }

      async function pinAs(userId: string, connectionIds: string[], agent = AGENT) {
        await upsertMemberPin(scope, {
          agentPackageId: agent,
          integrationId: INTEGRATION,
          connectionIds,
          userId,
        });
      }

      beforeEach(async () => {
        await seedPackage({
          id: OTHER_AGENT,
          orgId: ctx.orgId,
          type: "agent",
          homeSpaceId: scope.spaceId,
          draftManifest: {
            type: "agent",
            schema_version: "0.1",
            name: OTHER_AGENT,
            version: "1.0.0",
            display_name: "Other agent",
            prompt: "x",
            dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
          },
        });
        await seedSpacePackage(scope.spaceId, OTHER_AGENT, { enabled: true });
      });

      it("leaves the owner's own member pins, keeping the rest of each set in order", async () => {
        const [a, b, c] = await seedSharedConnections(3);
        await pinAs(memberId, [a!, b!, c!]);
        await pinAs(memberId, [b!, a!], OTHER_AGENT);

        await deleteOwnConnection(owner(), b!, authority());

        expect(await memberPinSet(memberId)).toEqual([a!, c!]);
        expect(await memberPinSet(memberId, OTHER_AGENT)).toEqual([a!]);
      });

      it("drops an owner's pin the delete empties, instead of breaking its 1..10 bound", async () => {
        const [a, b] = await seedSharedConnections(2);
        await pinAs(memberId, [a!]);
        await pinAs(memberId, [a!, b!], OTHER_AGENT);

        await deleteOwnConnection(owner(), a!, authority());

        expect(await memberPinSet(memberId)).toBeNull();
        expect(await memberPinSet(memberId, OTHER_AGENT)).toEqual([b!]);
      });

      it("keeps the id in a COLLEAGUE's pin — their set fails loudly, it never shrinks", async () => {
        const [a, b] = await seedSharedConnections(2);
        await pinAs(ctx.user.id, [a!, b!]);

        await deleteOwnConnection(owner(), b!, authority());

        expect(await memberPinSet(ctx.user.id)).toEqual([a!, b!]);
      });

      async function scheduleWith(
        connectionOverrides: Record<string, string[]> | null,
        actor: { userId?: string; endUserId?: string } = { userId: memberId },
      ): Promise<string> {
        const row = await seedSchedule({
          packageId: AGENT,
          orgId: ctx.orgId,
          spaceId: scope.spaceId,
          ...actor,
          connectionOverrides,
        });
        return row.id;
      }

      async function overridesOf(scheduleId: string): Promise<Record<string, string[]> | null> {
        const [row] = await db
          .select({ connectionOverrides: schedules.connectionOverrides })
          .from(schedules)
          .where(eq(schedules.id, scheduleId));
        return row!.connectionOverrides;
      }

      it("prunes the owner's own schedule overrides: a set shrinks, an emptied one drops and disables", async () => {
        const [a, b, c] = await seedSharedConnections(3);
        const shrinks = await scheduleWith({ [INTEGRATION]: [a!, b!] });
        const dropsKey = await scheduleWith({ [INTEGRATION]: [b!], [OTHER_INTEGRATION]: [c!] });
        const nulls = await scheduleWith({ [INTEGRATION]: [b!] });
        const untouched = await scheduleWith({ [INTEGRATION]: [a!] });

        await deleteOwnConnection(owner(), b!, authority());

        expect(await overridesOf(shrinks)).toEqual({ [INTEGRATION]: [a!] });
        expect(await overridesOf(dropsKey)).toEqual({ [OTHER_INTEGRATION]: [c!] });
        expect(await overridesOf(nulls)).toBeNull();
        expect(await overridesOf(untouched)).toEqual({ [INTEGRATION]: [a!] });
        // Only a schedule whose set was EMPTIED stops: it would otherwise fall back unattended.
        const enabled = await db
          .select({ id: schedules.id, enabled: schedules.enabled })
          .from(schedules)
          .where(inArray(schedules.id, [shrinks, dropsKey, nulls, untouched]));
        expect(Object.fromEntries(enabled.map((r) => [r.id, r.enabled]))).toEqual({
          [shrinks]: true,
          [dropsKey]: false,
          [nulls]: false,
          [untouched]: true,
        });
      });

      it("disables a COLLEAGUE's armed schedule naming it, its overrides kept, and its fire runs nothing", async () => {
        const [a, b] = await seedSharedConnections(2);
        const colleague = await seedSchedule({
          packageId: AGENT,
          orgId: ctx.orgId,
          spaceId: scope.spaceId,
          userId: ctx.user.id,
          nextRunAt: new Date(Date.now() + 3_600_000),
          connectionOverrides: { [INTEGRATION]: [a!, b!] },
        });

        const { disabledScheduleIds } = await deleteOwnConnection(owner(), b!, authority());

        expect(disabledScheduleIds).toEqual([colleague.id]);
        const [row] = await db.select().from(schedules).where(eq(schedules.id, colleague.id));
        expect(row).toMatchObject({
          enabled: false,
          disabledReason: "connection_deleted",
          nextRunAt: null,
          connectionOverrides: { [INTEGRATION]: [a!, b!] },
        });
        expect(await triggerScheduledRun(colleague.id)).toBeNull();
        expect(await db.select({ id: runs.id }).from(runs)).toEqual([]);
      });

      it("disables an END USER's armed schedule naming it: its actor has no user id", async () => {
        const [a] = await seedSharedConnections(1);
        const endUser = await seedEndUser({
          orgId: ctx.orgId,
          spaceId: scope.spaceId,
          externalId: "ext-eu-foreign-schedule",
        });
        const foreign = await seedSchedule({
          packageId: AGENT,
          orgId: ctx.orgId,
          spaceId: scope.spaceId,
          endUserId: endUser.id,
          connectionOverrides: { [INTEGRATION]: [a!] },
        });

        const { disabledScheduleIds } = await deleteOwnConnection(owner(), a!, authority());

        expect(disabledScheduleIds).toEqual([foreign.id]);
        const [row] = await db.select().from(schedules).where(eq(schedules.id, foreign.id));
        expect(row).toMatchObject({
          enabled: false,
          disabledReason: "connection_deleted",
          connectionOverrides: { [INTEGRATION]: [a!] },
        });
      });

      it("leaves a colleague's DISABLED schedule naming it as it is, its reason included", async () => {
        const [a] = await seedSharedConnections(1);
        const paused = await seedSchedule({
          packageId: AGENT,
          orgId: ctx.orgId,
          spaceId: scope.spaceId,
          userId: ctx.user.id,
          enabled: false,
          disabledReason: "actor_invalid",
          connectionOverrides: { [INTEGRATION]: [a!] },
        });

        const { disabledScheduleIds } = await deleteOwnConnection(owner(), a!, authority());

        expect(disabledScheduleIds).toEqual([]);
        const [row] = await db.select().from(schedules).where(eq(schedules.id, paused.id));
        expect(row).toEqual(paused);
      });

      it("prunes an end user's own schedules when the end user deletes", async () => {
        const endUser = await seedEndUser({
          orgId: ctx.orgId,
          spaceId: scope.spaceId,
          externalId: "ext-eu-schedule-prune",
        });
        const id = await seedConnection({ spaceId: scope.spaceId, endUserId: endUser.id });
        const own = await scheduleWith({ [INTEGRATION]: [id] }, { endUserId: endUser.id });
        // A member's schedule naming the same id is not the end user's to rewrite.
        const member = await scheduleWith({ [INTEGRATION]: [id] });

        await deleteOwnConnection({ type: "end_user", id: endUser.id }, id, authority());

        expect(await overridesOf(own)).toBeNull();
        expect(await overridesOf(member)).toEqual({ [INTEGRATION]: [id] });
      });

      it("an OAuth client delete forgets its minted connections the same way", async () => {
        const [minted, kept] = await seedSharedConnections(2);
        const clientId = await seedClientMinting([minted!]);
        await pinAs(memberId, [minted!, kept!]);
        await pinAs(memberId, [minted!], OTHER_AGENT);
        const emptied = await scheduleWith({ [INTEGRATION]: [minted!] });

        const { disabledScheduleIds } = await deleteIntegrationOAuthClient(
          scope,
          INTEGRATION,
          clientId,
        );

        expect(await memberPinSet(memberId)).toEqual([kept!]);
        expect(await memberPinSet(memberId, OTHER_AGENT)).toBeNull();
        expect(await overridesOf(emptied)).toBeNull();
        expect(disabledScheduleIds).toEqual([emptied]);
        const [row] = await db
          .select({ enabled: schedules.enabled })
          .from(schedules)
          .where(eq(schedules.id, emptied));
        expect(row!.enabled).toBe(false);
      });

      it("an OAuth client delete disables a colleague's schedule naming two of its connections once", async () => {
        const minted = await seedSharedConnections(2);
        const clientId = await seedClientMinting(minted);
        const colleague = await seedSchedule({
          packageId: AGENT,
          orgId: ctx.orgId,
          spaceId: scope.spaceId,
          userId: ctx.user.id,
          nextRunAt: new Date(Date.now() + 3_600_000),
          connectionOverrides: { [INTEGRATION]: minted },
        });

        const { disabledScheduleIds } = await deleteIntegrationOAuthClient(
          scope,
          INTEGRATION,
          clientId,
        );

        expect(disabledScheduleIds).toEqual([colleague.id]);
        const [row] = await db.select().from(schedules).where(eq(schedules.id, colleague.id));
        expect(row).toMatchObject({
          enabled: false,
          disabledReason: "connection_deleted",
          nextRunAt: null,
          connectionOverrides: { [INTEGRATION]: minted },
        });
      });

      it("an OAuth client delete forgets two minted connections sharing a pin and a schedule set", async () => {
        const minted = await seedSharedConnections(2);
        const clientId = await seedClientMinting(minted);
        await pinAs(memberId, minted);
        const emptied = await scheduleWith({ [INTEGRATION]: minted });

        const { deletedConnections, disabledScheduleIds } = await deleteIntegrationOAuthClient(
          scope,
          INTEGRATION,
          clientId,
        );

        // The pin goes and the schedule is disabled once, whichever connection is forgotten first.
        expect(deletedConnections).toBe(2);
        expect(await memberPinSet(memberId)).toBeNull();
        expect(await overridesOf(emptied)).toBeNull();
        expect(disabledScheduleIds).toEqual([emptied]);
      });

      it("touches no pin and no schedule when the delete is refused", async () => {
        const [a, b] = await seedSharedConnections(2);
        await pinAs(memberId, [a!, b!]);
        const schedule = await scheduleWith({ [INTEGRATION]: [a!, b!] });
        const stranger = { type: "user" as const, id: ctx.user.id };

        await expect(deleteOwnConnection(stranger, b!, authority())).rejects.toMatchObject({
          status: 404,
        });

        expect(await memberPinSet(memberId)).toEqual([a!, b!]);
        expect(await overridesOf(schedule)).toEqual({ [INTEGRATION]: [a!, b!] });
      });
    });

    for (const enforce of [true, false]) {
      it(`an ${enforce ? "ENFORCED" : "SOFT"} org default blocks delete and unshare (409 connection_pinned)`, async () => {
        const [toDelete, toUnshare] = await seedSharedConnections(2);
        await upsertOrgDefault(scope, INTEGRATION, {
          connectionIds: [toDelete!, toUnshare!],
          enforce,
          createdBy: ctx.user.id,
        });
        const owner = { type: "user" as const, id: memberId };
        await expect(deleteOwnConnection(owner, toDelete!, authority())).rejects.toMatchObject({
          status: 409,
          code: "connection_pinned",
        });
        await expect(
          updateConnection({
            connectionId: toUnshare!,
            viewer: viewer(memberId),
            sharedSpaceIds: [],
          }),
        ).rejects.toMatchObject({ status: 409, code: "connection_pinned" });
        const left = await db
          .select({ id: integrationConnections.id })
          .from(integrationConnections)
          .where(eq(integrationConnections.id, toDelete!));
        expect(left).toHaveLength(1);
      });
    }

    it("refuses to delete an OAuth client whose minted connection is pinned", async () => {
      const ids = await seedSharedConnections(1);
      const clientId = await seedClientMinting(ids);
      await upsertIntegrationPin(scope, INTEGRATION, {
        agentPackageId: AGENT,
        connectionIds: ids,
        createdBy: ctx.user.id,
      });
      await expect(
        deleteIntegrationOAuthClient(scope, INTEGRATION, clientId),
      ).rejects.toMatchObject({ status: 409, code: "connection_pinned" });
      const [kept] = await db
        .select({ id: integrationOauthClients.id })
        .from(integrationOauthClients)
        .where(eq(integrationOauthClients.id, clientId));
      expect(kept?.id).toBe(clientId);
    });

    it("refuses the whole set when ONE member is not shared", async () => {
      const [shared] = await seedSharedConnections(1);
      const personal = await seedConnection({
        spaceId: scope.spaceId,
        userId: memberId,
        shared: false,
      });
      await expect(
        upsertIntegrationPin(scope, INTEGRATION, {
          agentPackageId: AGENT,
          connectionIds: [shared!, personal],
          createdBy: ctx.user.id,
        }),
      ).rejects.toMatchObject({ status: 404, code: "not_found" });
      expect(await listIntegrationPins(scope, INTEGRATION)).toEqual([]);
    });
  });

  describe("renaming — a label is unique per owner (#1622)", () => {
    const rename = (connectionId: string, label: string, by = ctx.user.id) =>
      updateConnection({ connectionId, viewer: viewer(by), label });

    it("refuses a label another of the owner's connections holds (409 connection_label_taken)", async () => {
      await seedConnection({ spaceId: scope.spaceId, userId: ctx.user.id, label: "prod" });
      const mine = await seedConnection({
        spaceId: scope.spaceId,
        userId: ctx.user.id,
        label: "staging",
      });
      await expect(rename(mine, "prod")).rejects.toMatchObject({
        status: 409,
        code: "connection_label_taken",
      });
      const [row] = await db
        .select({ label: integrationConnections.label })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, mine));
      expect(row!.label).toBe("staging");
    });

    it("takes a label a colleague's connection holds: theirs is not disclosed by a refusal", async () => {
      await seedConnection({ spaceId: scope.spaceId, userId: memberId, label: "prod" });
      const mine = await seedConnection({ spaceId: scope.spaceId, userId: ctx.user.id });
      expect((await rename(mine, "prod")).connection.label).toBe("prod");
    });

    it("keeps its own label, and takes one that differs only by case or lives elsewhere", async () => {
      const mine = await seedConnection({
        spaceId: scope.spaceId,
        userId: ctx.user.id,
        label: "prod",
      });
      await seedConnection({
        integrationId: OTHER_INTEGRATION,
        spaceId: scope.spaceId,
        userId: ctx.user.id,
        label: "Prod",
      });
      // Control for the refusal above: the row's own label is not "another" row's.
      expect((await rename(mine, "prod")).connection.label).toBe("prod");
      // Verbatim comparison, the sidecar's enum: `Prod` is a second address.
      await seedConnection({ spaceId: scope.spaceId, userId: ctx.user.id, label: "staging" });
      expect((await rename(mine, "Staging")).connection.label).toBe("Staging");
      // `Prod` is taken on the OTHER integration only.
      expect((await rename(mine, "Prod")).connection.label).toBe("Prod");
    });

    it("a label of one scope does not collide with the owner's row of the other", async () => {
      await seedConnection({ spaceId: scope.spaceId, userId: ctx.user.id, label: "prod" });
      const orgRow = await seedConnection({
        spaceId: scope.spaceId,
        orgScope: true,
        userId: ctx.user.id,
      });
      expect((await rename(orgRow, "prod")).connection.label).toBe("prod");
    });
  });

  describe("org-scope rows — reach of the pickers", () => {
    let other: string;
    beforeEach(async () => {
      other = (await seedSpace({ orgId: ctx.orgId, name: "Other" })).id;
    });

    it("lists the actor's own org row connected elsewhere, and a colleague's only once shared here", async () => {
      const mine = await seedConnection({ spaceId: other, orgScope: true, userId: ctx.user.id });
      const sharedHere = await seedConnection({
        spaceId: other,
        orgScope: true,
        userId: memberId,
        sharedSpaceIds: [other, scope.spaceId],
      });
      await seedConnection({
        spaceId: other,
        orgScope: true,
        userId: memberId,
        sharedSpaceIds: [other],
      });
      const list = await listAccessibleConnections(scope, INTEGRATION, {
        type: "user",
        id: ctx.user.id,
      });
      expect(list.map((c) => c.id).sort()).toEqual([mine, sharedHere].sort());
      const byId = new Map(list.map((c) => [c.id, c]));
      // The owner sees every target and the origin; a colleague only "shared here".
      expect(byId.get(mine)).toMatchObject({
        scope: "org",
        shared_space_ids: [],
        origin_space_id: other,
      });
      expect(byId.get(sharedHere)).toMatchObject({
        scope: "org",
        shared_space_ids: [scope.spaceId],
        origin_space_id: null,
      });
    });

    it("pins an org row shared here, never one shared only elsewhere", async () => {
      const sharedHere = await seedConnection({
        spaceId: other,
        orgScope: true,
        userId: memberId,
        sharedSpaceIds: [scope.spaceId],
      });
      const sharedElsewhere = await seedConnection({
        spaceId: other,
        orgScope: true,
        userId: memberId,
        sharedSpaceIds: [other],
      });
      await validatePinTargets(scope, INTEGRATION, [sharedHere]);
      await expect(validatePinTargets(scope, INTEGRATION, [sharedElsewhere])).rejects.toMatchObject(
        { status: 404 },
      );
      // A member pin takes the member's own org row, connected from any space.
      const ownElsewhere = await seedConnection({
        spaceId: other,
        orgScope: true,
        userId: ctx.user.id,
      });
      await validatePinTargets(scope, INTEGRATION, [ownElsewhere], { allowOwnedBy: ctx.user.id });
    });

    it("a member pin refuses the member's own row in a space blocking user connections", async () => {
      await seedSpacePackage(scope.spaceId, INTEGRATION, { blockUserConnections: true });
      const own = await seedConnection({ spaceId: scope.spaceId, userId: ctx.user.id });
      const ownShared = await seedConnection({
        spaceId: scope.spaceId,
        userId: ctx.user.id,
        shared: true,
      });
      await expect(
        validatePinTargets(scope, INTEGRATION, [own], { allowOwnedBy: ctx.user.id }),
      ).rejects.toMatchObject({ status: 404 });
      await validatePinTargets(scope, INTEGRATION, [ownShared], { allowOwnedBy: ctx.user.id });
    });
  });

  describe("updateConnection — share targets", () => {
    let other: string;
    beforeEach(async () => {
      other = (await seedSpace({ orgId: ctx.orgId, name: "Other" })).id;
    });

    const ownerEdit = (
      connectionId: string,
      sharedSpaceIds: string[],
      spaceId: string | null = null,
    ) =>
      updateConnection({
        connectionId,
        viewer: { actor: { type: "user", id: memberId }, spaceId, governs: false },
        sharedSpaceIds,
      });

    it("the owner replaces the whole set, from any surface; added and removed are reported", async () => {
      const id = await seedConnection({ spaceId: other, orgScope: true, userId: memberId });
      const first = await ownerEdit(id, [scope.spaceId, other, scope.spaceId]);
      expect(first).toMatchObject({ isOwner: true, removed: [] });
      expect([...first.added].sort()).toEqual([scope.spaceId, other].sort());
      const second = await ownerEdit(id, [other], scope.spaceId);
      expect(second).toMatchObject({ added: [], removed: [scope.spaceId] });
      expect(await sharesOf(id)).toEqual([other]);
    });

    it("refuses a target outside the org, and a space-scoped row targeting another space (400)", async () => {
      const { defaultSpaceId: foreign } = await createTestOrg(memberId);
      const orgRow = await seedConnection({ spaceId: other, orgScope: true, userId: memberId });
      const spaceRow = await seedConnection({ spaceId: scope.spaceId, userId: memberId });
      for (const [id, targets] of [
        [orgRow, [foreign]],
        [orgRow, ["spc_unknown"]],
        [spaceRow, [other]],
      ] as const) {
        await expect(ownerEdit(id, [...targets])).rejects.toMatchObject({
          status: 400,
          code: "invalid_share_target",
        });
      }
      await ownerEdit(spaceRow, [scope.spaceId]);
      expect(await sharesOf(spaceRow)).toEqual([scope.spaceId]);
      expect(await sharesOf(orgRow)).toEqual([]);
    });

    it("refuses sharing an end user's connection (409)", async () => {
      const endUser = await seedEndUser({
        orgId: ctx.orgId,
        spaceId: scope.spaceId,
        externalId: "ext-eu-share",
      });
      const id = await seedConnection({ spaceId: scope.spaceId, endUserId: endUser.id });
      await expect(
        updateConnection({
          connectionId: id,
          viewer: {
            actor: { type: "end_user", id: endUser.id },
            spaceId: scope.spaceId,
            governs: false,
          },
          sharedSpaceIds: [scope.spaceId],
        }),
      ).rejects.toMatchObject({ status: 409, code: "end_user_connection_not_shareable" });
    });

    it("removing one target is refused only by a pin or default OF that target", async () => {
      const id = await seedConnection({
        spaceId: other,
        orgScope: true,
        userId: memberId,
        sharedSpaceIds: [scope.spaceId, other],
      });
      await upsertOrgDefault({ orgId: ctx.orgId, spaceId: other }, INTEGRATION, {
        connectionIds: [id],
        enforce: false,
        createdBy: ctx.user.id,
      });
      await expect(ownerEdit(id, [scope.spaceId])).rejects.toMatchObject({
        status: 409,
        code: "connection_pinned",
      });
      expect((await ownerEdit(id, [other])).removed).toEqual([scope.spaceId]);
    });

    it("disables a colleague's schedule of the removed target only", async () => {
      const AGENT = "@pinsorg/share-agent";
      await seedPackage({ id: AGENT, orgId: ctx.orgId, type: "agent", homeSpaceId: scope.spaceId });
      const id = await seedConnection({
        spaceId: other,
        orgScope: true,
        userId: memberId,
        sharedSpaceIds: [scope.spaceId, other],
      });
      const scheduleIn = (spaceId: string) =>
        seedSchedule({
          packageId: AGENT,
          orgId: ctx.orgId,
          spaceId,
          userId: ctx.user.id,
          connectionOverrides: { [INTEGRATION]: [id] },
        });
      const here = await scheduleIn(scope.spaceId);
      const there = await scheduleIn(other);

      const { disabledScheduleIds } = await ownerEdit(id, [other]);

      expect(disabledScheduleIds).toEqual([here.id]);
      const rows = await db
        .select({ id: schedules.id, enabled: schedules.enabled })
        .from(schedules)
        .where(inArray(schedules.id, [here.id, there.id]));
      expect(Object.fromEntries(rows.map((r) => [r.id, r.enabled]))).toEqual({
        [here.id]: false,
        [there.id]: true,
      });
    });

    describe("a governor of this space", () => {
      const governor = (): ConnectionViewer => viewer(ctx.user.id, true);

      it("withdraws this space only, sending the empty projection", async () => {
        const id = await seedConnection({
          spaceId: other,
          orgScope: true,
          userId: memberId,
          sharedSpaceIds: [scope.spaceId, other],
        });
        const update = await updateConnection({
          connectionId: id,
          viewer: governor(),
          sharedSpaceIds: [],
        });
        expect(update).toMatchObject({ isOwner: false, added: [], removed: [scope.spaceId] });
        expect(await sharesOf(id)).toEqual([other]);
      });

      it("may not add a target, nor rename an org row (403), but renames a row of this space", async () => {
        const orgRow = await seedConnection({
          spaceId: other,
          orgScope: true,
          userId: memberId,
          sharedSpaceIds: [scope.spaceId],
        });
        for (const edit of [{ sharedSpaceIds: [scope.spaceId] }, { label: "renamed" }]) {
          await expect(
            updateConnection({ connectionId: orgRow, viewer: governor(), ...edit }),
          ).rejects.toMatchObject({ status: 403 });
        }
        const spaceRow = await seedConnection({ spaceId: scope.spaceId, userId: memberId });
        const { connection } = await updateConnection({
          connectionId: spaceRow,
          viewer: governor(),
          label: "renamed",
        });
        expect(connection.label).toBe("renamed");
      });

      it("cannot see a colleague's org row not shared here (404), nor edit without governing (403)", async () => {
        const privateRow = await seedConnection({
          spaceId: other,
          orgScope: true,
          userId: memberId,
        });
        await expect(
          updateConnection({ connectionId: privateRow, viewer: governor(), sharedSpaceIds: [] }),
        ).rejects.toMatchObject({ status: 404 });
        const sharedHere = await seedConnection({
          spaceId: other,
          orgScope: true,
          userId: memberId,
          sharedSpaceIds: [scope.spaceId],
        });
        await expect(
          updateConnection({
            connectionId: sharedHere,
            viewer: viewer(ctx.user.id, false),
            sharedSpaceIds: [],
          }),
        ).rejects.toMatchObject({ status: 403 });
        // The account surface (no space) is the owner's alone.
        await expect(
          updateConnection({
            connectionId: sharedHere,
            viewer: { actor: { type: "user", id: ctx.user.id }, spaceId: null, governs: true },
            sharedSpaceIds: [],
          }),
        ).rejects.toMatchObject({ status: 404 });
      });
    });
  });

  describe("loadConnectionOwnership", () => {
    it("projects the owner columns for an existing connection", async () => {
      const id = await seedConnection({
        spaceId: scope.spaceId,
        userId: ctx.user.id,
        shared: true,
      });
      const ownership = await loadConnectionOwnership(id);
      expect(ownership).toEqual({
        orgId: ctx.orgId,
        spaceId: scope.spaceId,
        userId: ctx.user.id,
        endUserId: null,
        sharedSpaceIds: [scope.spaceId],
      });
    });

    it("returns null for an unknown connection id", async () => {
      expect(await loadConnectionOwnership(crypto.randomUUID())).toBeNull();
    });
  });
});
