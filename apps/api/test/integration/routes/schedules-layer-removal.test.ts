// SPDX-License-Identifier: Apache-2.0

/**
 * Removing a layer that names an integration's connection set — a member pin, an admin pin, an org
 * default — disables the schedules it leaves unnamed (`connection_set_unnamed`): the enabled ones
 * whose fired version uses the integration and that no `connection_overrides` key, pin or org
 * default names the set for afterwards, however many connections their actor holds. Each DELETE
 * answers how many it disabled. A connection delete that empties a member pin drops it, the same
 * removal, recorded as `connection_deleted`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { asc, eq, inArray } from "drizzle-orm";
import { asRecord } from "@appstrate/core/safe-json";
import { isEmbeddedDb, reservePgConnection } from "@appstrate/db/client";
import {
  auditEvents,
  integrationConnections,
  integrationOauthClients,
  integrationOrgDefaults,
  integrationPins,
  packages,
  schedules,
} from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedEndUser, seedSchedule } from "../../helpers/seed.ts";
import { seedDivergedAgent, seedSchedulableAgent } from "../../helpers/schedule-fixtures.ts";
import {
  seedConnectionTestIntegration,
  seedIntegrationConnection,
} from "../../helpers/run-connection-fixtures.ts";
import { seedShares } from "../../helpers/connection-shares.ts";
import { deactivatePackage } from "../../../src/services/space-packages.ts";
import { deleteOrgDefault } from "../../../src/services/integration-org-defaults-service.ts";
import { deletePin } from "../../../src/services/integration-pins-service.ts";
import {
  disableSchedulesLeftUnnamed,
  schedulesLayerMayName,
} from "../../../src/services/schedules-named-by-layer.ts";

const app = getTestApp();

const AGENT = "@unnamed/agent";
const OTHER_AGENT = "@unnamed/other-agent";
const INTEGRATION = "@unnamed/svc";

const memberPinPath = (agent = AGENT) =>
  `/api/me/integration-pins/${agent}/integrations/${INTEGRATION}`;
const ADMIN_PIN_PATH = `/api/integrations/${INTEGRATION}/pins/${AGENT}`;
const ORG_DEFAULT_PATH = `/api/integrations/${INTEGRATION}/default`;

/** An agent manifest configuring the integration with `config`; `null` declares none. */
function agentManifest(
  id: string,
  config: Record<string, unknown> | null = { tools: ["search"] },
): Record<string, unknown> {
  return {
    name: id,
    version: "1.0.0",
    type: "agent",
    schema_version: "0.2",
    display_name: "Layer Removal Agent",
    ...(config
      ? {
          dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
          integrations_configuration: { [INTEGRATION]: config },
        }
      : {}),
  };
}

describe("removing the layer that names a schedule's connection set", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "unnamed" });
    await seedConnectionTestIntegration(ctx, INTEGRATION);
    await seedAgent(AGENT);
  });

  async function seedAgent(id: string, config?: Record<string, unknown> | null): Promise<void> {
    await seedSchedulableAgent({
      id,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      manifest: agentManifest(id, config),
    });
  }

  /** An armed schedule of the context's user on `AGENT`, unless `overrides` say otherwise. */
  function armedSchedule(overrides: Partial<Parameters<typeof seedSchedule>[0]> = {}) {
    return seedSchedule({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      enabled: true,
      nextRunAt: new Date(Date.now() + 3_600_000),
      ...overrides,
    });
  }

  /** A connection of the context's user, shared into the space: what a pin or default may name. */
  async function sharedConnection(): Promise<string> {
    const id = await seedIntegrationConnection(ctx, INTEGRATION);
    await seedShares(id, [ctx.defaultSpaceId]);
    return id;
  }

  /** A pin on `agent`: the admin's (closed unless `open`), or `userId`'s own. */
  async function pin(
    connectionIds: string[],
    {
      userId = null,
      agent = AGENT,
      open = false,
    }: { userId?: string | null; agent?: string; open?: boolean } = {},
  ): Promise<void> {
    await db.insert(integrationPins).values({
      spaceId: ctx.defaultSpaceId,
      packageId: agent,
      integrationId: INTEGRATION,
      userId,
      connectionIds,
      allowAdditionalConnections: open,
    });
  }

  const ownPin = (ids: string[], agent = AGENT) => pin(ids, { userId: ctx.user.id, agent });

  async function orgDefault(connectionIds: string[], enforce = false): Promise<void> {
    await db.insert(integrationOrgDefaults).values({
      spaceId: ctx.defaultSpaceId,
      integrationId: INTEGRATION,
      connectionIds,
      enforce,
    });
  }

  /** DELETE `path` as the org owner; the count it answers. */
  async function remove(path: string): Promise<number> {
    const res = await app.request(path, { method: "DELETE", headers: authHeaders(ctx) });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { schedules_disabled_count: number };
    expect(Object.keys(body)).toEqual(["schedules_disabled_count"]);
    return body.schedules_disabled_count;
  }

  async function rowOf(id: string) {
    const [row] = await db.select().from(schedules).where(eq(schedules.id, id));
    return row!;
  }

  /** The schedules disabled for an unnamed set, by id. */
  async function unnamed(): Promise<string[]> {
    const rows = await db
      .select({ id: schedules.id })
      .from(schedules)
      .where(eq(schedules.disabledReason, "connection_set_unnamed"))
      .orderBy(asc(schedules.id));
    return rows.map((row) => row.id);
  }

  /** The ids of the still-enabled schedules among `rows`. */
  async function stillArmed(rows: { id: string }[]): Promise<string[]> {
    const enabled: string[] = [];
    for (const { id } of rows) if ((await rowOf(id)).enabled) enabled.push(id);
    return enabled;
  }

  /** The disabled schedules the removal's audit entry records, `null` when it records none. */
  async function auditedAs(action: string): Promise<string[] | null> {
    const [audit] = await db
      .select({ after: auditEvents.after })
      .from(auditEvents)
      .where(eq(auditEvents.action, action));
    const after = audit!.after as { disabledScheduleIds: string[] } | null;
    return after ? [...after.disabledScheduleIds].sort() : null;
  }

  describe("a member pin — DELETE /api/me/integration-pins/{agent}/integrations/{integration}", () => {
    for (const held of [2, 1]) {
      // The verdict does not count the actor's connections: one would bind by fallback.
      it(`disables the schedule the pin named the set for, its actor holding ${held} connection(s)`, async () => {
        const pinned = await seedIntegrationConnection(ctx, INTEGRATION);
        if (held === 2) await seedIntegrationConnection(ctx, INTEGRATION);
        await ownPin([pinned]);
        const schedule = await armedSchedule();

        expect(await remove(memberPinPath())).toBe(1);
        expect(await rowOf(schedule.id)).toMatchObject({
          enabled: false,
          disabledReason: "connection_set_unnamed",
          nextRunAt: null,
          connectionOverrides: null,
        });
        expect(await auditedAs("integration.member_pin.deleted")).toEqual([schedule.id]);
      });
    }

    for (const [what, set] of [
      ["to none", []],
      ["an unreachable connection", [crypto.randomUUID()]],
    ] as const) {
      // The pin decided the fire without binding: a warning, then an error, carry its source.
      it(`disables the schedule of a pin naming ${what}`, async () => {
        await seedIntegrationConnection(ctx, INTEGRATION);
        await ownPin([...set]);
        const schedule = await armedSchedule();

        expect(await remove(memberPinPath())).toBe(1);
        expect(await unnamed()).toEqual([schedule.id]);
      });
    }

    it("spares a schedule naming its own set, another member's, another agent's and a paused one", async () => {
      const pinned = await seedIntegrationConnection(ctx, INTEGRATION);
      await ownPin([pinned]);
      await seedAgent(OTHER_AGENT);
      const colleague = await memberContext(ctx, "member");
      const bound = await armedSchedule();
      const spared = [
        await armedSchedule({ connectionOverrides: { [INTEGRATION]: [pinned] } }),
        await armedSchedule({ connectionOverrides: { [INTEGRATION]: [] } }),
        await armedSchedule({ userId: colleague.user.id }),
        await armedSchedule({ packageId: OTHER_AGENT }),
      ];
      const paused = await armedSchedule({ enabled: false, nextRunAt: null });

      expect(await remove(memberPinPath())).toBe(1);
      expect(await unnamed()).toEqual([bound.id]);
      expect(await stillArmed(spared)).toEqual(spared.map((s) => s.id));
      expect(await rowOf(paused.id)).toMatchObject({ enabled: false, disabledReason: null });
    });

    it("spares a schedule a soft org default still names the set for", async () => {
      const shared = await sharedConnection();
      await ownPin([shared]);
      await orgDefault([shared]);
      const schedule = await armedSchedule();

      expect(await remove(memberPinPath())).toBe(0);
      expect((await rowOf(schedule.id)).enabled).toBe(true);
      expect(await auditedAs("integration.member_pin.deleted")).toBeNull();
    });

    it("spares a schedule an admin pin governs", async () => {
      const shared = await sharedConnection();
      await pin([shared]);
      await ownPin([shared]);
      const schedule = await armedSchedule();

      expect(await remove(memberPinPath())).toBe(0);
      expect((await rowOf(schedule.id)).enabled).toBe(true);
    });

    for (const [fired, config] of [
      ["no integration", null],
      ["the integration inert", { tools: [] }],
    ] as const) {
      // The draft declares it with a tool: only the schedule firing the draft uses it.
      it(`judges the version each schedule fires — published declares ${fired}`, async () => {
        const QUIET = "@unnamed/quiet";
        await seedDivergedAgent({
          id: QUIET,
          orgId: ctx.orgId,
          spaceId: ctx.defaultSpaceId,
          userId: ctx.user.id,
          published: agentManifest(QUIET, config),
          draft: agentManifest(QUIET),
        });
        await ownPin([await seedIntegrationConnection(ctx, INTEGRATION)], QUIET);
        const published = await armedSchedule({ packageId: QUIET });
        const draft = await armedSchedule({ packageId: QUIET, versionOverride: "draft" });

        expect(await remove(memberPinPath(QUIET))).toBe(1);
        expect(await unnamed()).toEqual([draft.id]);
        expect((await rowOf(published.id)).enabled).toBe(true);
      });
    }

    it("judges a schedule whose connection_overrides names only another integration", async () => {
      await ownPin([await seedIntegrationConnection(ctx, INTEGRATION)]);
      const schedule = await armedSchedule({
        connectionOverrides: { "@unnamed/other-svc": [crypto.randomUUID()] },
      });

      expect(await remove(memberPinPath())).toBe(1);
      expect(await unnamed()).toEqual([schedule.id]);
    });

    it("spares a schedule whose version does not resolve: its fire fails on its own", async () => {
      await ownPin([await seedIntegrationConnection(ctx, INTEGRATION)]);
      const schedule = await armedSchedule({ versionOverride: "9.9.9" });

      expect(await remove(memberPinPath())).toBe(0);
      expect((await rowOf(schedule.id)).enabled).toBe(true);
    });

    // The agent selects no tool: only the integration's draft, with a default one, makes it run.
    it("judges each schedule under its own dependency_overrides", async () => {
      const DEFAULTED = "@unnamed/defaulted";
      await seedAgent(DEFAULTED, {});
      const [integration] = await db.select().from(packages).where(eq(packages.id, INTEGRATION));
      await db
        .update(packages)
        .set({
          draftManifest: { ...asRecord(integration!.draftManifest), default_tools: ["search"] },
        })
        .where(eq(packages.id, INTEGRATION));
      await ownPin([await seedIntegrationConnection(ctx, INTEGRATION)], DEFAULTED);
      const published = await armedSchedule({ packageId: DEFAULTED });
      const draft = await armedSchedule({
        packageId: DEFAULTED,
        dependencyOverrides: { [INTEGRATION]: "draft" },
      });

      expect(await remove(memberPinPath(DEFAULTED))).toBe(1);
      expect(await unnamed()).toEqual([draft.id]);
      expect((await rowOf(published.id)).enabled).toBe(true);
    });

    // Off in the space, the fire starts without the integration; back on, it would take the fallback.
    it("disables the schedule while the space has the integration switched off", async () => {
      await ownPin([await seedIntegrationConnection(ctx, INTEGRATION)]);
      const schedule = await armedSchedule();
      await deactivatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, INTEGRATION);

      expect(await remove(memberPinPath())).toBe(1);
      expect(await unnamed()).toEqual([schedule.id]);
    });

    it("answers 0 and disables nothing when there is no pin", async () => {
      await seedIntegrationConnection(ctx, INTEGRATION);
      const schedule = await armedSchedule();

      expect(await remove(memberPinPath())).toBe(0);
      expect((await rowOf(schedule.id)).enabled).toBe(true);
    });
  });

  describe("an admin pin — DELETE /api/integrations/{integration}/pins/{agent}", () => {
    it("disables the schedules of every actor an OPEN pin named the set for, sparing an actor with a pin of their own", async () => {
      const shared = await sharedConnection();
      await pin([shared], { open: true });
      const colleague = await memberContext(ctx, "member");
      // An addition outside the floor: the pin outlives the open floor (one within it would not).
      await pin([shared, await sharedConnection()], { userId: colleague.user.id });
      const endUser = await seedEndUser({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId });
      const bound = [
        await armedSchedule(),
        await armedSchedule({ userId: null, endUserId: endUser.id }),
      ];
      const pinnedByActor = await armedSchedule({ userId: colleague.user.id });

      expect(await remove(ADMIN_PIN_PATH)).toBe(2);
      const disabled = bound.map((s) => s.id).sort();
      expect(await unnamed()).toEqual(disabled);
      expect((await rowOf(pinnedByActor.id)).enabled).toBe(true);
      expect(await auditedAs("integration.pin.deleted")).toEqual(disabled);
    });

    it("a CLOSED pin purges the member pins it masked: the schedule relying on one is disabled too", async () => {
      const shared = await sharedConnection();
      await pin([shared]);
      const colleague = await memberContext(ctx, "member");
      await pin([shared], { userId: colleague.user.id });
      const bound = await armedSchedule();
      const pinnedByActor = await armedSchedule({ userId: colleague.user.id });

      // The open-pin case above is the control: there the same member pin spares its schedule.
      expect(await remove(ADMIN_PIN_PATH)).toBe(2);
      const disabled = [bound.id, pinnedByActor.id].sort();
      expect(await unnamed()).toEqual(disabled);
      expect(await db.select().from(integrationPins)).toEqual([]);
      expect(await auditedAs("integration.pin.deleted")).toEqual(disabled);
    });

    it("spares them all when an org default names the set", async () => {
      const shared = await sharedConnection();
      await pin([shared]);
      await orgDefault([shared]);
      const endUser = await seedEndUser({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId });
      const spared = [
        await armedSchedule(),
        await armedSchedule({ userId: null, endUserId: endUser.id }),
      ];

      expect(await remove(ADMIN_PIN_PATH)).toBe(0);
      expect(await stillArmed(spared)).toEqual(spared.map((s) => s.id));
    });
  });

  describe("an org default — DELETE /api/integrations/{integration}/default", () => {
    for (const enforce of [false, true]) {
      it(`disables across agents what the ${enforce ? "enforced" : "soft"} default named the set for, sparing what another layer names`, async () => {
        const PLAIN = "@unnamed/plain";
        const PINNED = "@unnamed/pinned";
        await seedAgent(OTHER_AGENT);
        await seedAgent(PLAIN, null);
        await seedAgent(PINNED);
        const shared = await sharedConnection();
        await orgDefault([shared], enforce);
        await pin([shared], { agent: PINNED });
        const colleague = await memberContext(ctx, "member");
        await pin([shared], { userId: colleague.user.id });
        // Under the enforced floor an override narrowing it added nothing: it goes too (A).
        const withinFloor = await armedSchedule({ connectionOverrides: { [INTEGRATION]: [] } });
        // The enforced default purged the colleague's pin it masked (I): their schedule is unnamed.
        const pinnedByActor = await armedSchedule({ userId: colleague.user.id });
        const bound = [
          await armedSchedule(),
          await armedSchedule({ packageId: OTHER_AGENT }),
          ...(enforce ? [withinFloor, pinnedByActor] : []),
        ];
        const spared = [
          await armedSchedule({ packageId: PLAIN }),
          await armedSchedule({ packageId: PINNED }),
          ...(enforce ? [] : [withinFloor, pinnedByActor]),
        ];

        expect(await remove(ORG_DEFAULT_PATH)).toBe(bound.length);
        const disabled = bound.map((s) => s.id).sort();
        expect(await unnamed()).toEqual(disabled);
        expect(await stillArmed(spared)).toEqual(spared.map((s) => s.id));
        expect(await auditedAs("integration.org_default.deleted")).toEqual(disabled);
      });
    }

    it("an enforced default's PUT and DELETE purge the member pins it masks, and audit them (#2043 I)", async () => {
      await seedAgent(OTHER_AGENT);
      const shared = await sharedConnection();
      const colleague = await memberContext(ctx, "member");
      await ownPin([shared]);
      /** The `memberPinsCleared` of the last `action` audit entry. */
      const clearedBy = async (action: string) => {
        const rows = await db
          .select({ after: auditEvents.after })
          .from(auditEvents)
          .where(eq(auditEvents.action, action))
          .orderBy(asc(auditEvents.id));
        return asRecord(rows.at(-1)!.after).memberPinsCleared;
      };

      const res = await app.request(ORG_DEFAULT_PATH, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ connection_ids: [shared], enforce: true }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await clearedBy("integration.org_default.upserted")).toEqual([
        { userId: ctx.user.id, agentPackageId: AGENT, connectionIds: [shared] },
      ]);

      // Written past the write rule while the default is enforced: its DELETE purges it too, and
      // the schedule that relied on it is left unnamed.
      await pin([shared], { userId: colleague.user.id, agent: OTHER_AGENT });
      const relied = await armedSchedule({ userId: colleague.user.id, packageId: OTHER_AGENT });
      expect(await remove(ORG_DEFAULT_PATH)).toBe(1);
      expect(await unnamed()).toEqual([relied.id]);
      expect(await clearedBy("integration.org_default.deleted")).toEqual([
        { userId: colleague.user.id, agentPackageId: OTHER_AGENT, connectionIds: [shared] },
      ]);
      expect(await db.select().from(integrationPins)).toEqual([]);
    });
  });

  describe("removing an imposed floor never changes what a stored selection means (#2043 A)", () => {
    /**
     * A floor of two shared connections and one schedule per selection shape. `within` strictly
     * narrow the floor (`[]`, a strict subset, the same subset repeated in another case); `whole`
     * names the floor itself in another order and case, which binds the same ungoverned (H);
     * `outside` names an addition, `noKey` names nothing (another layer, when the case keeps one,
     * names its set).
     */
    async function selections() {
      const [a, b, c] = [
        await sharedConnection(),
        await sharedConnection(),
        await sharedConnection(),
      ];
      const floor = [a, b];
      const within = [
        await armedSchedule({ connectionOverrides: { [INTEGRATION]: [] } }),
        await armedSchedule({ connectionOverrides: { [INTEGRATION]: [a] } }),
        await armedSchedule({ connectionOverrides: { [INTEGRATION]: [a.toUpperCase(), a] } }),
      ];
      const whole = await armedSchedule({
        connectionOverrides: { [INTEGRATION]: [b.toUpperCase(), a] },
      });
      const outside = await armedSchedule({ connectionOverrides: { [INTEGRATION]: [a, c] } });
      const noKey = await armedSchedule();
      return { floor, a, b, c, within, whole, outside, noKey };
    }

    for (const open of [false, true]) {
      it(`an admin pin DELETE (${open ? "open" : "closed"}) disables the schedules strictly narrowing its floor`, async () => {
        const { floor, a, b, c, within, whole, outside, noKey } = await selections();
        await pin(floor, { open });
        await orgDefault([a]); // soft: names the set of the schedule with no key
        const colleague = await memberContext(ctx, "member");
        const other = await memberContext(ctx, "member");
        const third = await memberContext(ctx, "member");
        await pin([], { userId: colleague.user.id });
        await pin([a, c], { userId: other.user.id });
        await pin([b, a], { userId: third.user.id });

        expect(await remove(ADMIN_PIN_PATH)).toBe(within.length);
        const disabled = within.map((s) => s.id).sort();
        expect(await unnamed()).toEqual(disabled);
        expect(await stillArmed([whole, outside, noKey])).toEqual([whole.id, outside.id, noKey.id]);
        expect(await auditedAs("integration.pin.deleted")).toEqual(disabled);
        // Open: the member pin narrowing the floor goes; the one adding a connection and the one
        // naming the whole floor stay.
        const memberPins = await db
          .select({ userId: integrationPins.userId })
          .from(integrationPins);
        expect(memberPins.map((p) => p.userId).sort()).toEqual(
          open ? [other.user.id, third.user.id].sort() : [],
        );
      });
    }

    it("an admin pin DELETE of `[]` disables no schedule selecting `[]`: nothing narrows an empty floor (H)", async () => {
      await pin([]);
      const empty = await armedSchedule({ connectionOverrides: { [INTEGRATION]: [] } });

      expect(await remove(ADMIN_PIN_PATH)).toBe(0);
      expect(await stillArmed([empty])).toEqual([empty.id]);
    });

    it("an admin pin DELETE under an enforced default leaves them: a floor still governs", async () => {
      const { floor, within } = await selections();
      await pin(floor);
      await orgDefault(floor, true);

      expect(await remove(ADMIN_PIN_PATH)).toBe(0);
      expect(await stillArmed(within)).toEqual(within.map((s) => s.id));
    });

    it("an enforced default DELETE disables them, sparing an agent an admin pin still governs", async () => {
      const PINNED = "@unnamed/pinned";
      await seedAgent(PINNED);
      const { floor, within, whole, outside, noKey } = await selections();
      await orgDefault(floor, true);
      await pin(floor, { agent: PINNED });
      const governed = await armedSchedule({
        packageId: PINNED,
        connectionOverrides: { [INTEGRATION]: [] },
      });

      // The schedule with no key is left unnamed by the default's removal, the existing rule.
      expect(await remove(ORG_DEFAULT_PATH)).toBe(within.length + 1);
      expect(await unnamed()).toEqual([...within, noKey].map((s) => s.id).sort());
      expect(await stillArmed([whole, outside, governed])).toEqual([
        whole.id,
        outside.id,
        governed.id,
      ]);
    });

    it("writing an enforced default back soft (PUT enforce: false) disables them, and audits them", async () => {
      const { floor, within, whole, outside, noKey } = await selections();
      await orgDefault(floor, true);

      const put = (enforce: boolean) =>
        app.request(ORG_DEFAULT_PATH, {
          method: "PUT",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({ connection_ids: floor, enforce }),
        });
      const res = await put(false);
      expect(res.status, await res.clone().text()).toBe(200);
      const disabled = within.map((s) => s.id).sort();
      // The stored default, and how many schedules the write disabled.
      expect(await res.json()).toMatchObject({
        connection_ids: floor,
        enforce: false,
        schedules_disabled_count: disabled.length,
      });
      expect(await unnamed()).toEqual(disabled);
      expect(await stillArmed([whole, outside, noKey])).toEqual([whole.id, outside.id, noKey.id]);
      const [audit] = await db
        .select({ after: auditEvents.after })
        .from(auditEvents)
        .where(eq(auditEvents.action, "integration.org_default.upserted"));
      const after = asRecord(audit!.after);
      expect([...(after.disabledScheduleIds as string[])].sort()).toEqual(disabled);

      // Soft → soft, and soft → enforced, remove no floor: nothing more is disabled.
      const armed = await armedSchedule({ connectionOverrides: { [INTEGRATION]: [] } });
      for (const enforce of [false, true]) {
        const again = await put(enforce);
        expect(again.status).toBe(200);
        const body = (await again.json()) as { schedules_disabled_count: number };
        expect(body.schedules_disabled_count).toBe(0);
      }
      expect((await rowOf(armed.id)).enabled).toBe(true);
    });
  });

  describe("a member pin dropped by a connection delete", () => {
    async function deleteConnection(id: string): Promise<void> {
      const res = await app.request(`/api/me/connections/${id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });
      expect(res.status, await res.clone().text()).toBe(204);
    }

    async function ownPins(): Promise<string[][]> {
      const rows = await db.select().from(integrationPins);
      return rows.map((row) => row.connectionIds);
    }

    it("disables the schedule of the pin DELETE /api/me/connections/{id} empties, sparing one naming another set", async () => {
      const gone = await seedIntegrationConnection(ctx, INTEGRATION);
      const kept = await seedIntegrationConnection(ctx, INTEGRATION);
      await ownPin([gone]);
      const bound = await armedSchedule();
      const named = await armedSchedule({ connectionOverrides: { [INTEGRATION]: [kept] } });

      await deleteConnection(gone);

      expect(await ownPins()).toEqual([]);
      expect(await rowOf(bound.id)).toMatchObject({
        enabled: false,
        disabledReason: "connection_deleted",
        nextRunAt: null,
        connectionOverrides: null,
      });
      expect(await rowOf(named.id)).toMatchObject({
        enabled: true,
        connectionOverrides: { [INTEGRATION]: [kept] },
      });
      expect(await auditedAs("integration.connection.deleted")).toEqual([bound.id]);
    });

    it("spares the schedule when the pin only shrinks", async () => {
      const gone = await seedIntegrationConnection(ctx, INTEGRATION);
      const kept = await seedIntegrationConnection(ctx, INTEGRATION);
      await ownPin([gone, kept]);
      const schedule = await armedSchedule();

      await deleteConnection(gone);

      expect(await ownPins()).toEqual([[kept]]);
      expect((await rowOf(schedule.id)).enabled).toBe(true);
      expect(await auditedAs("integration.connection.deleted")).toEqual([]);
    });

    // A patch read before the delete still lands: its compare-and-set is on `updated_at`.
    it("holds a schedule another layer still names without writing it", async () => {
      const gone = await seedIntegrationConnection(ctx, INTEGRATION);
      await ownPin([gone]);
      await orgDefault([await sharedConnection()]);
      const schedule = await armedSchedule();

      await deleteConnection(gone);

      expect(await ownPins()).toEqual([]);
      const spared = await rowOf(schedule.id);
      expect(spared.enabled).toBe(true);
      expect(spared.updatedAt).toEqual(schedule.updatedAt);
    });

    for (const minting of [1, 2]) {
      // With two, the first forget shrinks the pin and the second drops it.
      it(`disables it when an OAuth client delete drops a pin of ${minting} minted connection(s)`, async () => {
        const minted: string[] = [];
        while (minted.length < minting) {
          minted.push(await seedIntegrationConnection(ctx, INTEGRATION));
        }
        const [client] = await db
          .insert(integrationOauthClients)
          .values({
            orgId: ctx.orgId,
            spaceId: ctx.defaultSpaceId,
            integrationId: INTEGRATION,
            authKey: "primary",
            clientId: "byo-app",
            clientSecretEncrypted: "x",
          })
          .returning({ id: integrationOauthClients.id });
        await db
          .update(integrationConnections)
          .set({ clientRef: client!.id })
          .where(inArray(integrationConnections.id, minted));
        await ownPin(minted);
        const schedule = await armedSchedule();

        const res = await app.request(
          `/api/integrations/${INTEGRATION}/oauth-clients/${client!.id}`,
          {
            method: "DELETE",
            headers: authHeaders(ctx),
          },
        );

        expect(res.status, await res.clone().text()).toBe(204);
        expect(await ownPins()).toEqual([]);
        expect(await rowOf(schedule.id)).toMatchObject({
          enabled: false,
          disabledReason: "connection_deleted",
        });
        expect(await auditedAs("integration.oauth_client.deleted")).toEqual([schedule.id]);
      });
    }
  });

  // The fires are read before the removal's transaction opens; every layer fact is read inside it.
  describe("writes landing between the read of the fires and the removal", () => {
    const pinLayer = () =>
      ({
        kind: "member_pin",
        spaceId: ctx.defaultSpaceId,
        integrationId: INTEGRATION,
        agentPackageId: AGENT,
        userId: ctx.user.id,
      }) as const;

    /** The pin's removal, run with the ids its read returned earlier. */
    function removePinWith(scheduleIds: string[]): Promise<string[]> {
      return db.transaction(async (tx) => {
        await tx.delete(integrationPins);
        return disableSchedulesLeftUnnamed(tx, pinLayer(), scheduleIds, "connection_set_unnamed");
      });
    }

    it("spares a schedule a write names a set for, or pauses", async () => {
      const pinned = await seedIntegrationConnection(ctx, INTEGRATION);
      await ownPin([pinned]);
      const [named, paused, left] = [
        await armedSchedule(),
        await armedSchedule(),
        await armedSchedule(),
      ];
      const read = await schedulesLayerMayName(pinLayer());
      expect([...read].sort()).toEqual([named.id, paused.id, left.id].sort());

      await db
        .update(schedules)
        .set({ connectionOverrides: { [INTEGRATION]: [pinned] } })
        .where(eq(schedules.id, named.id));
      await db.update(schedules).set({ enabled: false }).where(eq(schedules.id, paused.id));

      expect(await removePinWith(read)).toEqual([left.id]);
      expect(await unnamed()).toEqual([left.id]);
      expect(await rowOf(paused.id)).toMatchObject({ enabled: false, disabledReason: null });
    });

    it("disables a schedule holding a key for the integration at the read, dropped before the removal", async () => {
      const pinned = await seedIntegrationConnection(ctx, INTEGRATION);
      await ownPin([pinned]);
      const schedule = await armedSchedule({ connectionOverrides: { [INTEGRATION]: [pinned] } });
      const read = await schedulesLayerMayName(pinLayer());

      await db
        .update(schedules)
        .set({ connectionOverrides: null })
        .where(eq(schedules.id, schedule.id));

      expect(await removePinWith(read)).toEqual([schedule.id]);
    });

    it("disables a schedule paused at the read and enabled before the removal", async () => {
      await ownPin([await seedIntegrationConnection(ctx, INTEGRATION)]);
      const schedule = await armedSchedule({ enabled: false, nextRunAt: null });
      const read = await schedulesLayerMayName(pinLayer());

      await db.update(schedules).set({ enabled: true }).where(eq(schedules.id, schedule.id));

      expect(await removePinWith(read)).toEqual([schedule.id]);
    });

    // The default's removal reads while the pin stands, and the pin's removal while the default does.
    it("disables a schedule the removal of its other layer spared in between", async () => {
      const shared = await sharedConnection();
      await ownPin([shared]);
      await orgDefault([shared]);
      const schedule = await armedSchedule();
      const defaultLayer = {
        kind: "org_default",
        spaceId: ctx.defaultSpaceId,
        integrationId: INTEGRATION,
      } as const;
      const read = await schedulesLayerMayName(defaultLayer);

      expect(await remove(memberPinPath())).toBe(0);
      expect((await rowOf(schedule.id)).enabled).toBe(true);
      const disabled = await db.transaction(async (tx) => {
        await tx.delete(integrationOrgDefaults);
        return disableSchedulesLeftUnnamed(tx, defaultLayer, read, "connection_set_unnamed");
      });

      expect(disabled).toEqual([schedule.id]);
      expect(await unnamed()).toEqual([schedule.id]);
    });
  });

  // Each has deleted its own layer and neither has committed: a verdict read by either now still
  // finds the other's layer, and both would spare the schedule.
  describe("the removals of a schedule's two layers in flight at once", () => {
    it.skipIf(isEmbeddedDb)("disables the schedule once", async () => {
      const shared = await sharedConnection();
      await ownPin([shared]);
      await orgDefault([shared]);
      const schedule = await armedSchedule();
      const scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
      const holder = (await reservePgConnection())!;
      const removals: Promise<unknown>[] = [];
      try {
        // Held on the schedule's row: both removals stop at their lock, their delete behind them.
        await holder.sql`BEGIN`;
        await holder.sql`SELECT id FROM package_schedules WHERE id = ${schedule.id} FOR UPDATE`;
        const pinRemoval = deletePin(scope, AGENT, INTEGRATION, ctx.user.id);
        const defaultRemoval = deleteOrgDefault(scope, INTEGRATION);
        removals.push(pinRemoval, defaultRemoval);

        // The second waits on the first's tuple lock, not on the holder: follow the queue. Read
        // from pg_locks, live: pg_stat_activity is frozen at this transaction's first read of it.
        const bothQueued = async () => {
          const until = Date.now() + 3_000;
          while (Date.now() < until) {
            const [row] = await holder.sql<{ queued: number }[]>`
              WITH RECURSIVE waiting AS (
                SELECT pid FROM pg_locks
                WHERE NOT granted AND pg_backend_pid() = ANY (pg_blocking_pids(pid))
                UNION
                SELECT l.pid FROM pg_locks l
                JOIN waiting w ON w.pid = ANY (pg_blocking_pids(l.pid))
                WHERE NOT l.granted
              )
              SELECT count(*)::int AS queued FROM waiting`;
            if (row?.queued === 2) return true;
            await Bun.sleep(10);
          }
          return false;
        };
        expect(await bothQueued()).toBe(true);
        await holder.sql`COMMIT`;

        const [byPin, byDefault] = await Promise.all([pinRemoval, defaultRemoval]);
        expect(byPin.previous).toEqual([shared]);
        expect(byDefault.previous).not.toBeNull();
        // The first through the lock spares it; the second reads its verdict after that commit.
        expect([...byPin.disabledScheduleIds, ...byDefault.disabledScheduleIds]).toEqual([
          schedule.id,
        ]);
        expect(await rowOf(schedule.id)).toMatchObject({
          enabled: false,
          disabledReason: "connection_set_unnamed",
        });
      } finally {
        await holder.sql`ROLLBACK`;
        holder.release();
        await Promise.allSettled(removals);
      }
    });
  });
});
