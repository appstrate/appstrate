// SPDX-License-Identifier: Apache-2.0

/**
 * E-extra — integration org-defaults service.
 *
 * Default connection set per (space, integration): the cross-agent
 * governance baseline. CRUD round-trip + org isolation.
 *
 * `upsertOrgDefault` delegates target validation to `validatePinTargets`
 * (shared-only), so the seeded connection must serve the space, be shared
 * into it, and reference the integration.
 *
 * Enforcing is refused while an admin pin of the integration is open to
 * additions (#2043): an enforced default is always closed. A write or delete
 * where the default is, or was, enforced purges the member pins it masks, of
 * every agent no admin pin governs (#2043 I).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestUser, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedSpace, seedSpacePackage } from "../../helpers/seed.ts";
import { seedShares } from "../../helpers/connection-shares.ts";
import { eq, isNotNull, isNull } from "drizzle-orm";
import { integrationConnections, integrationPins } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import {
  upsertOrgDefault,
  getOrgDefault,
  listOrgDefaultsForResolver,
  deleteOrgDefault,
} from "../../../src/services/integration-org-defaults-service.ts";
import type { SpaceScope } from "../../../src/lib/scope.ts";

const INTEGRATION_ID = "@official/gmail";

function integrationManifest(): Record<string, unknown> {
  return {
    schema_version: "0.1",
    type: "integration",
    name: INTEGRATION_ID,
    version: "1.0.0",
    display_name: "Gmail",
    source: { kind: "local", server: { name: "@official/gmail-server", version: "^1.0.0" } },
    auths: {
      primary: {
        type: "api_key",
        authorized_uris: ["https://api/*"],
        credentials: { schema: { type: "object", properties: { api_key: { type: "string" } } } },
        delivery: { http: { in: "header", name: "X-Api-Key", value: "{$credential.api_key}" } },
      },
    },
  };
}

describe("integration-org-defaults-service", () => {
  let ctx: TestContext;
  let scope: SpaceScope;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orgdef" });
    scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integrationManifest(),
    });
  });

  /** Seed an org-scope connection connected from `originSpaceId`, shared into `sharedSpaceIds`. */
  async function seedSharedConnection(
    originSpaceId = ctx.defaultSpaceId,
    label: string | null = null,
    sharedSpaceIds = [originSpaceId],
  ): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION_ID,
        authKey: "primary",
        accountId: "acct-shared",
        orgId: ctx.orgId,
        spaceId: null,
        originSpaceId,
        userId: ctx.user.id,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "k" } }),
        scopesGranted: [],
        label: label ?? `Connexion ${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning({ id: integrationConnections.id });
    await seedShares(row!.id, sharedSpaceIds);
    return row!.id;
  }

  it("names a row shared here from any origin, never one shared only elsewhere", async () => {
    const other = (await seedSpace({ orgId: ctx.orgId, name: "Other" })).id;
    const sharedHere = await seedSharedConnection(other, null, [ctx.defaultSpaceId]);
    const sharedElsewhere = await seedSharedConnection(ctx.defaultSpaceId, null, [other]);

    const { orgDefault } = await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: [sharedHere],
      enforce: false,
    });
    expect(orgDefault.connection_ids).toEqual([sharedHere]);
    await expect(
      upsertOrgDefault(scope, INTEGRATION_ID, {
        connectionIds: [sharedElsewhere],
        enforce: false,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("round-trips upsert → get → resolver-shape → delete (idempotent)", async () => {
    const connId = await seedSharedConnection();

    // upsert
    const { previous, orgDefault: created } = await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: [connId],
      enforce: true,
    });
    expect(previous).toBeNull();
    expect(created.connection_ids).toEqual([connId]);
    expect(created.enforce).toBe(true);

    // get
    const fetched = await getOrgDefault(scope, INTEGRATION_ID);
    expect(fetched).not.toBeNull();
    expect(fetched!.connection_ids).toEqual([connId]);
    expect(fetched!.enforce).toBe(true);

    // listOrgDefaultsForResolver shape
    const resolverMap = await listOrgDefaultsForResolver(ctx.defaultSpaceId);
    expect(resolverMap[INTEGRATION_ID]).toEqual({ connectionIds: [connId], enforce: true });

    // delete
    const del = await deleteOrgDefault(scope, INTEGRATION_ID);
    expect(del.previous).toMatchObject({ connection_ids: [connId], enforce: true });
    expect(await getOrgDefault(scope, INTEGRATION_ID)).toBeNull();

    // delete is idempotent — second delete reports nothing removed.
    const del2 = await deleteOrgDefault(scope, INTEGRATION_ID);
    expect(del2.previous).toBeNull();
  });

  it("upsert replaces the existing default on the (app, integration) unique index", async () => {
    const connA = await seedSharedConnection();
    const connB = await seedSharedConnection();

    await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: [connA],
      enforce: false,
    });
    const { previous, orgDefault: replaced } = await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: [connB],
      enforce: true,
    });
    expect(previous).toMatchObject({ connection_ids: [connA], enforce: false });
    expect(replaced.connection_ids).toEqual([connB]);
    expect(replaced.enforce).toBe(true);

    const fetched = await getOrgDefault(scope, INTEGRATION_ID);
    expect(fetched!.connection_ids).toEqual([connB]);
    expect(fetched!.enforce).toBe(true);
  });

  it("a default is a SET: N connections in the caller's order, replaced wholesale", async () => {
    const a = await seedSharedConnection(ctx.defaultSpaceId, "a");
    const b = await seedSharedConnection(ctx.defaultSpaceId, "b");
    const c = await seedSharedConnection(ctx.defaultSpaceId, "c");
    const expected = [c, a, b];

    const { orgDefault: created } = await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: expected,
      enforce: true,
    });
    expect(created.connection_ids).toEqual(expected);
    expect(await listOrgDefaultsForResolver(ctx.defaultSpaceId)).toEqual({
      [INTEGRATION_ID]: { connectionIds: expected, enforce: true },
    });

    // Replacement, not a merge.
    await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: [c],
      enforce: false,
    });
    const fetched = await getOrgDefault(scope, INTEGRATION_ID);
    expect(fetched!.connection_ids).toEqual([c]);
    expect(fetched!.enforce).toBe(false);
  });

  it("deleting a member leaves its id in the set — an enforced default never shrinks", async () => {
    const a = await seedSharedConnection(ctx.defaultSpaceId, "staging");
    const b = await seedSharedConnection(ctx.defaultSpaceId, "prod");
    await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: [a, b],
      enforce: true,
    });
    await db.delete(integrationConnections).where(eq(integrationConnections.id, a));
    expect(await listOrgDefaultsForResolver(ctx.defaultSpaceId)).toEqual({
      [INTEGRATION_ID]: { connectionIds: [a, b], enforce: true },
    });
  });

  it("getOrgDefault returns null when no default is set", async () => {
    expect(await getOrgDefault(scope, INTEGRATION_ID)).toBeNull();
    expect(await listOrgDefaultsForResolver(ctx.defaultSpaceId)).toEqual({});
  });

  describe("enforcing beside an admin pin open to additions (#2043)", () => {
    const AGENT_A = "@orgdef/agent-a";
    const AGENT_B = "@orgdef/agent-b";

    /** An admin pin row of `agent` over `connectionId`, written straight to the table. */
    async function adminPinRow(
      agent: string,
      connectionId: string,
      allowAdditionalConnections: boolean,
      spaceId = ctx.defaultSpaceId,
    ): Promise<void> {
      await db.insert(integrationPins).values({
        spaceId,
        packageId: agent,
        integrationId: INTEGRATION_ID,
        userId: null,
        connectionIds: [connectionId],
        allowAdditionalConnections,
      });
    }

    beforeEach(async () => {
      for (const id of [AGENT_A, AGENT_B]) {
        await seedPackage({ id, orgId: ctx.orgId, type: "agent" });
        await seedSpacePackage(ctx.defaultSpaceId, id);
      }
    });

    it("ignores the open admin pin of an agent not active in the space (#2043 D)", async () => {
      const connId = await seedSharedConnection();
      await seedSpacePackage(ctx.defaultSpaceId, AGENT_B, { enabled: false });
      await adminPinRow(AGENT_B, connId, true);

      const { orgDefault } = await upsertOrgDefault(scope, INTEGRATION_ID, {
        connectionIds: [connId],
        enforce: true,
      });
      expect(orgDefault.enforce).toBe(true);

      // Active again, it still counts.
      await seedSpacePackage(ctx.defaultSpaceId, AGENT_B, { enabled: true });
      await deleteOrgDefault(scope, INTEGRATION_ID);
      await expect(
        upsertOrgDefault(scope, INTEGRATION_ID, { connectionIds: [connId], enforce: true }),
      ).rejects.toMatchObject({ status: 409, code: "connection_additions_conflict" });
    });

    it("refuses enforce: true (409) naming every open agent, and writes nothing", async () => {
      const connId = await seedSharedConnection();
      await adminPinRow(AGENT_B, connId, true);
      await adminPinRow(AGENT_A, connId, true);

      const refusal = await upsertOrgDefault(scope, INTEGRATION_ID, {
        connectionIds: [connId],
        enforce: true,
      }).then(
        () => null,
        (err: unknown) => err as { status: number; code: string; message: string },
      );
      expect(refusal).toMatchObject({ status: 409, code: "connection_additions_conflict" });
      expect(refusal!.message).toContain(`'${AGENT_A}', '${AGENT_B}'`);
      expect(await getOrgDefault(scope, INTEGRATION_ID)).toBeNull();
    });

    it("accepts enforce: true when every admin pin is closed, or open only in another space", async () => {
      const other = (await seedSpace({ orgId: ctx.orgId, name: "Other" })).id;
      const connId = await seedSharedConnection(ctx.defaultSpaceId, null, [
        ctx.defaultSpaceId,
        other,
      ]);
      await adminPinRow(AGENT_A, connId, false);
      await adminPinRow(AGENT_B, connId, true, other);

      const { orgDefault } = await upsertOrgDefault(scope, INTEGRATION_ID, {
        connectionIds: [connId],
        enforce: true,
      });
      expect(orgDefault.enforce).toBe(true);
    });

    it("accepts a soft default beside an open admin pin", async () => {
      const connId = await seedSharedConnection();
      await adminPinRow(AGENT_A, connId, true);

      const { orgDefault } = await upsertOrgDefault(scope, INTEGRATION_ID, {
        connectionIds: [connId],
        enforce: false,
      });
      expect(orgDefault.enforce).toBe(false);
    });
  });

  describe("an enforced default purges the member pins it masks (#2043 I)", () => {
    const AGENT = "@orgdef/unpinned";
    const OTHER_AGENT = "@orgdef/unpinned-other";
    const PINNED = "@orgdef/pinned";
    /** Not active here: an open admin pin of it does not refuse enforcing the default. */
    const OPEN_PINNED = "@orgdef/open-pinned";

    /**
     * Every default transition: the default before (none / soft / enforced) and the write or
     * delete. Every member pin of the (space, integration) goes wherever the default is, or was,
     * enforced — an admin pin's agent included, open or closed; the soft-only transitions keep them.
     */
    const transitions: Array<{
      before: "none" | "soft" | "enforced";
      act: "soft" | "enforced" | "delete";
      purges: boolean;
    }> = [
      { before: "none", act: "soft", purges: false },
      { before: "none", act: "enforced", purges: true },
      { before: "soft", act: "soft", purges: false },
      { before: "soft", act: "enforced", purges: true },
      { before: "soft", act: "delete", purges: false },
      { before: "enforced", act: "enforced", purges: true },
      { before: "enforced", act: "soft", purges: true },
      { before: "enforced", act: "delete", purges: true },
    ];

    /** Every member pin, as `space|agent|user`, sorted. */
    async function memberPins(): Promise<string[]> {
      const rows = await db.select().from(integrationPins).where(isNotNull(integrationPins.userId));
      return rows.map((r) => `${r.spaceId}|${r.packageId}|${r.userId}`).sort();
    }

    beforeEach(async () => {
      for (const id of [AGENT, OTHER_AGENT, PINNED]) {
        await seedPackage({ id, orgId: ctx.orgId, type: "agent" });
        await seedSpacePackage(ctx.defaultSpaceId, id);
      }
      await seedPackage({ id: OPEN_PINNED, orgId: ctx.orgId, type: "agent" });
    });

    for (const { before, act, purges } of transitions) {
      it(`${before} → ${act === "delete" ? "deleted" : act} ${purges ? "purges" : "keeps"} every member pin, an admin pin's agent's included`, async () => {
        const connId = await seedSharedConnection();
        const addition = await seedSharedConnection();
        if (before !== "none") {
          await upsertOrgDefault(scope, INTEGRATION_ID, {
            connectionIds: [connId],
            enforce: before === "enforced",
          });
        }
        const elsewhere = (await seedSpace({ orgId: ctx.orgId, name: "Elsewhere" })).id;
        const colleague = (await createTestUser()).id;
        // Agents an admin pin governs, closed and open: an enforced default masks their member pins
        // too (a closed pin admits no addition, the enforced default closes an open one).
        await db.insert(integrationPins).values([
          {
            spaceId: ctx.defaultSpaceId,
            packageId: PINNED,
            integrationId: INTEGRATION_ID,
            userId: null,
            connectionIds: [connId],
          },
          {
            spaceId: ctx.defaultSpaceId,
            packageId: OPEN_PINNED,
            integrationId: INTEGRATION_ID,
            userId: null,
            connectionIds: [connId],
            allowAdditionalConnections: true,
          },
        ]);
        /** A member pin row written straight to the table, past the write rule. */
        const memberPin = async (agent: string, userId: string, spaceId = ctx.defaultSpaceId) => {
          await db.insert(integrationPins).values({
            spaceId,
            packageId: agent,
            integrationId: INTEGRATION_ID,
            userId,
            connectionIds: [addition],
          });
          return `${spaceId}|${agent}|${userId}`;
        };
        const masked = [
          await memberPin(AGENT, ctx.user.id),
          await memberPin(AGENT, colleague),
          await memberPin(OTHER_AGENT, ctx.user.id),
          await memberPin(PINNED, ctx.user.id),
          await memberPin(OPEN_PINNED, colleague),
        ];
        const controls = [await memberPin(AGENT, ctx.user.id, elsewhere)];

        const { memberPinsCleared } =
          act === "delete"
            ? await deleteOrgDefault(scope, INTEGRATION_ID)
            : await upsertOrgDefault(scope, INTEGRATION_ID, {
                connectionIds: [connId],
                enforce: act === "enforced",
              });

        expect(await memberPins()).toEqual((purges ? controls : [...controls, ...masked]).sort());
        const cleared = [
          { userId: ctx.user.id, agentPackageId: AGENT, connectionIds: [addition] },
          { userId: colleague, agentPackageId: AGENT, connectionIds: [addition] },
          { userId: ctx.user.id, agentPackageId: OTHER_AGENT, connectionIds: [addition] },
          { userId: ctx.user.id, agentPackageId: PINNED, connectionIds: [addition] },
          { userId: colleague, agentPackageId: OPEN_PINNED, connectionIds: [addition] },
        ].sort(
          (a, b) =>
            a.agentPackageId.localeCompare(b.agentPackageId) || a.userId.localeCompare(b.userId),
        );
        expect(memberPinsCleared).toEqual(purges ? cleared : []);
        // The admin pin itself is never touched.
        const adminPins = await db
          .select({ packageId: integrationPins.packageId })
          .from(integrationPins)
          .where(isNull(integrationPins.userId));
        expect(adminPins.map((p) => p.packageId).sort()).toEqual([OPEN_PINNED, PINNED].sort());
      });
    }
  });

  it("org isolation: one org cannot read another org's default", async () => {
    const connId = await seedSharedConnection();
    await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: [connId],
      enforce: true,
    });

    // A second org with its own space — must not see org 1's default.
    const otherCtx = await createTestContext({ orgSlug: "orgdef-other" });
    const otherScope: SpaceScope = {
      orgId: otherCtx.orgId,
      spaceId: otherCtx.defaultSpaceId,
    };
    expect(await getOrgDefault(otherScope, INTEGRATION_ID)).toBeNull();
    expect(await listOrgDefaultsForResolver(otherCtx.defaultSpaceId)).toEqual({});
  });
});
