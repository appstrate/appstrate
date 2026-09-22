// SPDX-License-Identifier: Apache-2.0

/**
 * Service-level tests for the DB-querying access/ownership logic in
 * integration-pins-service. The resolver's cascade is unit-tested in
 * integration-connection-resolver with hand-built candidate arrays; this
 * file exercises the real Drizzle queries those candidates come from:
 *
 *   - validatePinTarget — cross-space / cross-integration / sharing /
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
import { seedPackage, seedSpace, seedSpacePackage } from "../../helpers/seed.ts";
import { integrationConnections } from "@appstrate/db/schema";
import type { SpaceScope } from "../../../src/lib/scope.ts";
import {
  validatePinTarget,
  listAccessibleConnections,
  listAgentsConsumingIntegration,
  loadConnectionOwnership,
  listIntegrationPins,
  upsertIntegrationPin,
} from "../../../src/services/integration-pins-service.ts";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";

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

  describe("validatePinTarget", () => {
    it("throws notFound for an unknown connection id", async () => {
      await expect(validatePinTarget(scope, INTEGRATION, crypto.randomUUID(), {})).rejects.toThrow(
        /not found/i,
      );
    });

    it("rejects a connection from a different space", async () => {
      const otherSpace = await seedSpace({ orgId: ctx.orgId, name: "Other" });
      const id = await seedConnection({ spaceId: otherSpace.id, userId: ctx.user.id });
      await expect(validatePinTarget(scope, INTEGRATION, id, {})).rejects.toThrow(
        /different space/i,
      );
    });

    it("rejects a connection belonging to a different integration", async () => {
      const id = await seedConnection({
        integrationId: OTHER_INTEGRATION,
        spaceId: scope.spaceId,
        userId: ctx.user.id,
      });
      await expect(validatePinTarget(scope, INTEGRATION, id, {})).rejects.toThrow(
        /belongs to integration/i,
      );
    });

    it("rejects a non-shared connection when requireShared is set", async () => {
      const id = await seedConnection({
        spaceId: scope.spaceId,
        userId: ctx.user.id,
        sharedWithOrg: false,
      });
      await expect(
        validatePinTarget(scope, INTEGRATION, id, { requireShared: true }),
      ).rejects.toThrow(/sharedWithOrg/i);
    });

    it("accepts a shared connection under requireShared", async () => {
      const id = await seedConnection({
        spaceId: scope.spaceId,
        userId: memberId,
        sharedWithOrg: true,
      });
      const conn = await validatePinTarget(scope, INTEGRATION, id, { requireShared: true });
      expect(conn.id).toBe(id);
    });

    it("rejects allowOwnedBy when the connection is neither owned nor shared", async () => {
      const id = await seedConnection({
        spaceId: scope.spaceId,
        userId: memberId,
        sharedWithOrg: false,
      });
      await expect(
        validatePinTarget(scope, INTEGRATION, id, { allowOwnedBy: ctx.user.id }),
      ).rejects.toThrow(/owned by you or shared/i);
    });

    it("accepts allowOwnedBy when the caller owns the connection", async () => {
      const id = await seedConnection({
        spaceId: scope.spaceId,
        userId: ctx.user.id,
      });
      const conn = await validatePinTarget(scope, INTEGRATION, id, { allowOwnedBy: ctx.user.id });
      expect(conn.id).toBe(id);
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
          await seedConnection({
            spaceId: scope.spaceId,
            userId: memberId,
            sharedWithOrg: true,
            label: `conn-${i}`,
          }),
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

    it("pins N connections as N rows folded into one summary", async () => {
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

    it("a second write REPLACES the set — a dropped connection leaves no row", async () => {
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

    it("refuses more than the cap, and accepts exactly the cap", async () => {
      const ids = await seedSharedConnections(MAX_CONNECTIONS_PER_INTEGRATION + 1);
      // The cap is on the SET, so the excess is one id over, not one label over.
      await expect(
        upsertIntegrationPin(scope, INTEGRATION, {
          agentPackageId: AGENT,
          connectionIds: ids,
          createdBy: ctx.user.id,
        }),
      ).rejects.toThrow(new RegExp(`between 1 and ${MAX_CONNECTIONS_PER_INTEGRATION}`));

      const capped = ids.slice(0, MAX_CONNECTIONS_PER_INTEGRATION);
      const pin = await upsertIntegrationPin(scope, INTEGRATION, {
        agentPackageId: AGENT,
        connectionIds: capped,
        createdBy: ctx.user.id,
      });
      expect(pin.connection_ids).toHaveLength(MAX_CONNECTIONS_PER_INTEGRATION);
    });

    it("refuses an empty set and a repeated id", async () => {
      const ids = await seedSharedConnections(1);
      await expect(
        upsertIntegrationPin(scope, INTEGRATION, {
          agentPackageId: AGENT,
          connectionIds: [],
          createdBy: ctx.user.id,
        }),
      ).rejects.toThrow(/between 1 and/);
      await expect(
        upsertIntegrationPin(scope, INTEGRATION, {
          agentPackageId: AGENT,
          connectionIds: [ids[0]!, ids[0]!],
          createdBy: ctx.user.id,
        }),
      ).rejects.toThrow(/must not repeat/);
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
      ).rejects.toThrow(/sharedWithOrg/i);
      expect(await listIntegrationPins(scope, INTEGRATION)).toEqual([]);
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
