// SPDX-License-Identifier: Apache-2.0

/**
 * Service-level tests for the DB-querying access/ownership logic in
 * integration-pins-service. The resolver's cascade is unit-tested in
 * integration-connection-resolver with hand-built candidate arrays; this
 * file exercises the real Drizzle queries those candidates come from:
 *
 *   - validatePinTargets — cross-space / cross-integration / sharing /
 *     ownership rejection (the gate every pin write passes through)
 *   - listAccessibleConnections — own ∪ sharedWithOrg, deduped, scoped
 *     to (space, integration), filtered by actor
 *   - loadConnectionOwnership — owner projection used by RBAC checks
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
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
  updateConnectionMetadata,
} from "../../../src/services/integration-pins-service.ts";
import {
  deleteIntegrationConnection,
  deleteIntegrationOAuthClient,
} from "../../../src/services/integration-connections.ts";
import { upsertOrgDefault } from "../../../src/services/integration-org-defaults-service.ts";

const INTEGRATION = "@official/gmail";
const OTHER_INTEGRATION = "@official/clickup";

async function seedConnection(opts: {
  integrationId?: string;
  spaceId: string;
  authKey?: string;
  accountId?: string;
  userId?: string | null;
  endUserId?: string | null;
  sharedWithOrg?: boolean;
  label?: string;
}): Promise<string> {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      integrationId: opts.integrationId ?? INTEGRATION,
      authKey: opts.authKey ?? "google",
      accountId: opts.accountId ?? `acct-${crypto.randomUUID().slice(0, 8)}`,
      spaceId: opts.spaceId,
      userId: opts.userId ?? null,
      endUserId: opts.endUserId ?? null,
      credentialsEncrypted: "x",
      scopesGranted: ["openid", "email"],
      sharedWithOrg: opts.sharedWithOrg ?? false,
      label: opts.label ?? `Connexion ${crypto.randomUUID().slice(0, 8)}`,
    })
    .returning({ id: integrationConnections.id });
  return row!.id;
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
        sharedWithOrg: true,
      });
      const ofOtherIntegration = await seedConnection({
        integrationId: OTHER_INTEGRATION,
        spaceId: scope.spaceId,
        userId: memberId,
        sharedWithOrg: true,
      });
      const privateRow = await seedConnection({
        spaceId: scope.spaceId,
        userId: memberId,
        sharedWithOrg: false,
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
        sharedWithOrg: true,
      });
      const unknown = crypto.randomUUID();
      const answer = await refusal([shared, unknown], unknown, {});
      expect(answer).toEqual(await refusal([unknown], unknown, {}));
    });

    it("accepts a set of shared connections under the shared-only default", async () => {
      const ids = [
        await seedConnection({ spaceId: scope.spaceId, userId: memberId, sharedWithOrg: true }),
        await seedConnection({ spaceId: scope.spaceId, userId: ctx.user.id, sharedWithOrg: true }),
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
        await seedConnection({ spaceId: scope.spaceId, userId: memberId, sharedWithOrg: true }),
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
        sharedWithOrg: true,
      });
      // Owned AND shared by the caller — must appear exactly once.
      const ownAndShared = await seedConnection({
        spaceId: scope.spaceId,
        userId: ctx.user.id,
        sharedWithOrg: true,
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
        sharedWithOrg: true,
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
      expect(listed.map((a) => a.packageId)).toEqual(["@pinsorg/runs-here"]);
    });

    it("a pin is refused for an agent this space does not RUN", async () => {
      const connectionId = await seedConnection({
        spaceId: scope.spaceId,
        userId: memberId,
        sharedWithOrg: true,
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
      const pin = await upsertIntegrationPin(scope, INTEGRATION, {
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
        ids.push(
          await seedConnection({ spaceId: scope.spaceId, userId: memberId, sharedWithOrg: true }),
        );
      }
      return ids.sort();
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
      const pin = await upsertIntegrationPin(scope, INTEGRATION, {
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
      await upsertIntegrationPin(scope, INTEGRATION, {
        agentPackageId: AGENT,
        connectionIds: ids,
        createdBy: ctx.user.id,
      });
      await upsertIntegrationPin(scope, INTEGRATION, {
        agentPackageId: AGENT,
        connectionIds: [ids[2]!],
        createdBy: ctx.user.id,
      });
      const listed = await listIntegrationPins(scope, INTEGRATION);
      expect(listed).toHaveLength(1);
      expect(listed[0]!.connection_ids).toEqual([ids[2]!]);
      expect(listed[0]!.connection_ids).not.toContain(ids[0]!);
    });

    it("echoes what the next read returns, in the caller's order", async () => {
      const ids = await seedSharedConnections(2);
      const reversed = [...ids].reverse();
      const pin = await upsertIntegrationPin(scope, INTEGRATION, {
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
        updateConnectionMetadata(ids[1]!, { sharedWithOrg: false }),
      ).rejects.toMatchObject({ status: 409, code: "connection_pinned" });
      // Control: a shared connection outside the set unshares freely.
      const [outside] = await seedSharedConnections(1);
      const row = await updateConnectionMetadata(outside!, { sharedWithOrg: false });
      expect(row.sharedWithOrg).toBe(false);
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
        const pin = await upsertIntegrationPin(scope, INTEGRATION, {
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
      await expect(deleteIntegrationConnection(scope, ids[1]!, owner)).rejects.toMatchObject({
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
      await deleteIntegrationConnection(scope, outside!, owner);
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
      await deleteIntegrationConnection(scope, ownPinned!, owner);
      await deleteIntegrationConnection(scope, colleaguePinned!, owner);
      expect(
        (await updateConnectionMetadata(toUnshare!, { sharedWithOrg: false })).sharedWithOrg,
      ).toBe(false);
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

        await deleteIntegrationConnection(scope, b!, owner());

        expect(await memberPinSet(memberId)).toEqual([a!, c!]);
        expect(await memberPinSet(memberId, OTHER_AGENT)).toEqual([a!]);
      });

      it("drops an owner's pin the delete empties, instead of breaking its 1..10 bound", async () => {
        const [a, b] = await seedSharedConnections(2);
        await pinAs(memberId, [a!]);
        await pinAs(memberId, [a!, b!], OTHER_AGENT);

        await deleteIntegrationConnection(scope, a!, owner());

        expect(await memberPinSet(memberId)).toBeNull();
        expect(await memberPinSet(memberId, OTHER_AGENT)).toEqual([b!]);
      });

      it("keeps the id in a COLLEAGUE's pin — their set fails loudly, it never shrinks", async () => {
        const [a, b] = await seedSharedConnections(2);
        await pinAs(ctx.user.id, [a!, b!]);

        await deleteIntegrationConnection(scope, b!, owner());

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

        await deleteIntegrationConnection(scope, b!, owner());

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

      it("keeps the id in a COLLEAGUE's schedule — it fails loudly, it never shrinks", async () => {
        const [a, b] = await seedSharedConnections(2);
        const colleague = await scheduleWith({ [INTEGRATION]: [a!, b!] }, { userId: ctx.user.id });

        await deleteIntegrationConnection(scope, b!, owner());

        expect(await overridesOf(colleague)).toEqual({ [INTEGRATION]: [a!, b!] });
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

        await deleteIntegrationConnection(scope, id, { type: "end_user", id: endUser.id });

        expect(await overridesOf(own)).toBeNull();
        expect(await overridesOf(member)).toEqual({ [INTEGRATION]: [id] });
      });

      it("touches no pin and no schedule when the delete is refused", async () => {
        const [a, b] = await seedSharedConnections(2);
        await pinAs(memberId, [a!, b!]);
        const schedule = await scheduleWith({ [INTEGRATION]: [a!, b!] });
        const stranger = { type: "user" as const, id: ctx.user.id };

        await expect(deleteIntegrationConnection(scope, b!, stranger)).rejects.toMatchObject({
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
        await expect(deleteIntegrationConnection(scope, toDelete!, owner)).rejects.toMatchObject({
          status: 409,
          code: "connection_pinned",
        });
        await expect(
          updateConnectionMetadata(toUnshare!, { sharedWithOrg: false }),
        ).rejects.toMatchObject({ status: 409, code: "connection_pinned" });
        const left = await db
          .select({ id: integrationConnections.id })
          .from(integrationConnections)
          .where(eq(integrationConnections.id, toDelete!));
        expect(left).toHaveLength(1);
      });
    }

    it("refuses to delete an OAuth client whose minted connection is pinned", async () => {
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
      const ids = await seedSharedConnections(1);
      await db
        .update(integrationConnections)
        .set({ clientRef: client!.id })
        .where(eq(integrationConnections.id, ids[0]!));
      await upsertIntegrationPin(scope, INTEGRATION, {
        agentPackageId: AGENT,
        connectionIds: ids,
        createdBy: ctx.user.id,
      });
      await expect(
        deleteIntegrationOAuthClient(scope, INTEGRATION, client!.id),
      ).rejects.toMatchObject({
        status: 409,
        code: "connection_pinned",
      });
      const [kept] = await db
        .select({ id: integrationOauthClients.id })
        .from(integrationOauthClients)
        .where(eq(integrationOauthClients.id, client!.id));
      expect(kept?.id).toBe(client!.id);
    });

    it("refuses the whole set when ONE member is not shared", async () => {
      const [shared] = await seedSharedConnections(1);
      const personal = await seedConnection({
        spaceId: scope.spaceId,
        userId: memberId,
        sharedWithOrg: false,
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

  describe("renaming — a label is unique per (space, integration)", () => {
    it("refuses a label another owner's connection holds (409 connection_label_taken)", async () => {
      await seedConnection({ spaceId: scope.spaceId, userId: memberId, label: "prod" });
      const mine = await seedConnection({
        spaceId: scope.spaceId,
        userId: ctx.user.id,
        label: "staging",
      });
      await expect(updateConnectionMetadata(mine, { label: "prod" })).rejects.toMatchObject({
        status: 409,
        code: "connection_label_taken",
      });
      const [row] = await db
        .select({ label: integrationConnections.label })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, mine));
      expect(row!.label).toBe("staging");
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
      expect((await updateConnectionMetadata(mine, { label: "prod" })).label).toBe("prod");
      // Verbatim comparison, the sidecar's enum: `Prod` is a second address.
      await seedConnection({ spaceId: scope.spaceId, userId: memberId, label: "staging" });
      expect((await updateConnectionMetadata(mine, { label: "Staging" })).label).toBe("Staging");
      // `Prod` is taken on the OTHER integration only.
      expect((await updateConnectionMetadata(mine, { label: "Prod" })).label).toBe("Prod");
    });
  });

  describe("loadConnectionOwnership", () => {
    it("projects the owner columns for an existing connection", async () => {
      const id = await seedConnection({ spaceId: scope.spaceId, userId: ctx.user.id });
      const ownership = await loadConnectionOwnership(id);
      expect(ownership).toEqual({
        spaceId: scope.spaceId,
        userId: ctx.user.id,
        endUserId: null,
      });
    });

    it("returns null for an unknown connection id", async () => {
      expect(await loadConnectionOwnership(crypto.randomUUID())).toBeNull();
    });
  });
});
