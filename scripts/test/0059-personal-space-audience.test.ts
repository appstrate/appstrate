// SPDX-License-Identifier: Apache-2.0

/** Script `0059` against the test database: a personal space keeps only what its organization offers. */

import { beforeEach, describe, expect, it } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db, toRows } from "@appstrate/db/client";
import {
  auditEvents,
  notifications,
  orgPackageOffers,
  schedules,
  spacePackages,
} from "@appstrate/db/schema";
import { runPersonalSpaceAudience } from "../migration/0059-personal-space-audience.ts";
import {
  assertNoPendingDataScripts,
  PENDING_DATA_SCRIPTS,
} from "../../apps/api/src/lib/boot-guards/pending-data-scripts.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../apps/api/test/helpers/auth.ts";
import {
  seedOrgOffer,
  seedPackage,
  seedSchedule,
  seedSpace,
  seedSpacePackage,
} from "../../apps/api/test/helpers/seed.ts";

const TEAM_AGENT = "@mig0059/team-agent";
const OWN_AGENT = "@mig0059/own-agent";
const OFFERED = "@mig0059/offered";
const INT_ON = "@mig0059/int-on";
const INT_OFF = "@mig0059/int-off";
const SYSTEM = "@mig0059/system";
const ENTRY = PENDING_DATA_SCRIPTS.find((e) => e.after === "0117")!;

let ctx: TestContext;
let home: string;
let personal: string;
let team: string;
const lines: string[] = [];
const run = (apply: boolean) =>
  runPersonalSpaceAudience({ apply, out: (line) => lines.push(line) });
const pending = async () => {
  const err = await assertNoPendingDataScripts(null, [ENTRY]).then(
    () => null,
    (e: Error) => e,
  );
  return err === null ? 0 : Number(/: (\d+) pending/.exec(err.message)![1]);
};
const rowsOf = async (spaceId: string) =>
  (await db.select().from(spacePackages).where(eq(spacePackages.spaceId, spaceId)))
    .map((r) => r.packageId)
    .sort();

/** The kind CHECK is NOT VALID after drizzle 0117 and still refuses the retired kind: re-state it to seed one. */
async function insertRetiredNotification() {
  await db.execute(sql`ALTER TABLE notifications DROP CONSTRAINT notifications_type_valid`);
  await db.insert(notifications).values({
    orgId: ctx.orgId,
    spaceId: personal,
    recipientType: "user",
    recipientId: ctx.user.id,
    type: "package_shared" as never,
  });
  await db.execute(sql`ALTER TABLE notifications ADD CONSTRAINT notifications_type_valid
    CHECK (type IN ('run_failed', 'agent_message', 'credential_needs_reconnection')) NOT VALID`);
}

async function constraintValidated(): Promise<boolean> {
  const [row] = toRows<{ convalidated: boolean }>(
    await db.execute(
      "SELECT convalidated FROM pg_constraint WHERE conname = 'notifications_type_valid'",
    ),
  );
  return row!.convalidated;
}

describe("0059 — personal spaces take the org offer only", () => {
  beforeEach(async () => {
    await truncateAll();
    lines.length = 0;
    ctx = await createTestContext({ orgSlug: "mig0059" });
    home = (await seedSpace({ orgId: ctx.orgId, name: "Home" })).id;
    team = (await seedSpace({ orgId: ctx.orgId, name: "Team" })).id;
    personal = (
      await seedSpace({
        orgId: ctx.orgId,
        name: "Mine",
        ownerUserId: ctx.user.id,
        visibility: "private",
      })
    ).id;
    await seedPackage({ id: TEAM_AGENT, orgId: ctx.orgId, type: "agent", homeSpaceId: home });
    await seedPackage({ id: OWN_AGENT, orgId: ctx.orgId, type: "agent", homeSpaceId: personal });
    await seedPackage({ id: OFFERED, orgId: ctx.orgId, type: "skill", homeSpaceId: home });
    await seedPackage({ id: INT_ON, orgId: ctx.orgId, type: "integration", homeSpaceId: home });
    await seedPackage({ id: INT_OFF, orgId: ctx.orgId, type: "integration", homeSpaceId: home });
    await seedPackage({ id: SYSTEM, orgId: null, type: "skill", source: "system" });
    await seedOrgOffer(ctx.orgId, OFFERED, "available");
  });

  async function seedLegacyState() {
    await seedSpacePackage(personal, OWN_AGENT, { enabled: true });
    await seedSpacePackage(personal, OFFERED, { enabled: true });
    await seedSpacePackage(personal, SYSTEM, { enabled: true });
    await seedSpacePackage(personal, INT_ON, { enabled: true });
    await seedSpacePackage(personal, INT_OFF, { enabled: false });
    await seedSpacePackage(personal, TEAM_AGENT, { enabled: true, sharedBy: ctx.user.id });
    await seedSpacePackage(team, TEAM_AGENT, { enabled: true });
    await seedSpacePackage(team, INT_ON, { enabled: true });
    await seedSchedule({
      packageId: TEAM_AGENT,
      userId: ctx.user.id,
      orgId: ctx.orgId,
      spaceId: personal,
      enabled: true,
    });
    await seedSchedule({
      packageId: TEAM_AGENT,
      userId: ctx.user.id,
      orgId: ctx.orgId,
      spaceId: team,
      enabled: true,
    });
    await insertRetiredNotification();
  }

  it("a dry run writes nothing", async () => {
    await seedLegacyState();
    const before = await pending();
    const dry = await run(false);
    expect(lines[0]).toStartWith("database: ");
    expect(lines.at(-1)).toContain("DRY RUN");
    expect(dry.offers).toHaveLength(1);
    expect(dry.deleted).toHaveLength(2);
    expect(await db.select().from(orgPackageOffers)).toHaveLength(1);
    expect(await rowsOf(personal)).toHaveLength(6);
    expect(await db.select().from(notifications)).toHaveLength(1);
    expect(await constraintValidated()).toBe(false);
    expect(await pending()).toBe(before);
  });

  it("--apply offers the enabled integration, deletes the rest, and leaves the rest alone", async () => {
    await seedLegacyState();
    expect(await pending()).toBe(4); // team agent + INT_ON + INT_OFF rows, one notification

    const applied = await run(true);
    expect(applied.offers).toEqual([{ orgId: ctx.orgId, packageId: INT_ON }]);
    expect(
      applied.deleted.map((d) => [d.packageId, d.enabled, d.schedulesDisabled]).sort(),
    ).toEqual([
      [INT_OFF, false, 0],
      [TEAM_AGENT, true, 1],
    ]);
    expect(applied.notificationsDeleted).toBe(1);
    expect(lines).toContain(
      "offers created: 1, rows deleted: 2, schedules disabled: 1, notifications deleted: 1",
    );
    expect(lines.at(-1)).toBe("0059: APPLIED — committed.");

    // (a) the offer, with its audit; the row stays.
    const [offer] = await db
      .select()
      .from(orgPackageOffers)
      .where(eq(orgPackageOffers.packageId, INT_ON));
    expect(offer).toMatchObject({ mode: "available", offeredBy: null });
    const [offerAudit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "package.offered_to_org"));
    expect(offerAudit).toMatchObject({
      actorType: "system",
      resourceId: INT_ON,
      after: { orgId: ctx.orgId, mode: "available", reason: "personal_space_audience" },
    });
    // (b) deleted rows, schedule disabled, audits.
    expect(await rowsOf(personal)).toEqual([INT_ON, OFFERED, OWN_AGENT, SYSTEM].sort());
    expect(await rowsOf(team)).toEqual([INT_ON, TEAM_AGENT].sort());
    const personalSchedule = await db
      .select()
      .from(schedules)
      .where(and(eq(schedules.spaceId, personal), eq(schedules.packageId, TEAM_AGENT)));
    expect(personalSchedule[0]).toMatchObject({
      enabled: false,
      disabledReason: "package_removed",
    });
    const teamSchedule = await db.select().from(schedules).where(eq(schedules.spaceId, team));
    expect(teamSchedule[0]).toMatchObject({ enabled: true, disabledReason: null });
    const unshared = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "package.unshared"));
    expect(unshared.map((a) => a.resourceId).sort()).toEqual([INT_OFF, TEAM_AGENT]);
    expect(unshared[0]).toMatchObject({
      actorType: "system",
      spaceId: personal,
      after: { spaceId: personal, reason: "personal_space" },
    });
    // (c) notifications gone, CHECK validated.
    expect(await db.select().from(notifications)).toEqual([]);
    expect(await constraintValidated()).toBe(true);
    // The boot guard's count reaches 0.
    expect(await pending()).toBe(0);
  });

  it("a second --apply writes nothing", async () => {
    await seedLegacyState();
    await run(true);
    const auditCount = (await db.select().from(auditEvents)).length;
    lines.length = 0;
    const again = await run(true);
    expect(again).toEqual({
      offers: [],
      deleted: [],
      notificationsDeleted: 0,
    });
    expect((await db.select().from(auditEvents)).length).toBe(auditCount);
    expect(await pending()).toBe(0);
  });

  it("boots a database with nothing to fix", async () => {
    expect(await pending()).toBe(0);
  });
});
