// SPDX-License-Identifier: Apache-2.0

/**
 * Withdrawing a placement (#2045 R6, R7) — `DELETE /api/packages/{scope}/{name}/shares/{target}`
 * and the `keep_in_previous_home: false` move.
 *
 *   1. EITHER SIDE may withdraw: the home's `<type>:share`, or the target's
 *      deactivation grant (waived in the caller's own personal space). Somebody
 *      else's personal space named by id stays a 404.
 *   2. The package's schedules in that space go OFF in the same transaction,
 *      and nowhere else.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { Queue, type ConnectionOptions } from "bullmq";
import { auditEvents, packages, schedules, spacePackages } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { assertDbMissing, expectProblem, getDbRow } from "../../helpers/assertions.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedPackage,
  seedPublishedVersion,
  seedSchedule,
  seedSpace,
  seedSpaceMember,
  seedSpacePackage,
} from "../../helpers/seed.ts";
import { describeRequiresRedis } from "../../helpers/tier.ts";
import { closeRedis, flushRedis } from "../../helpers/redis.ts";
import { createSchedule } from "../../../src/services/scheduler.ts";
import { getRedisQueueConnection } from "../../../src/lib/redis.ts";

const app = getTestApp();
const AGENT = "@withdraw/worker";

type Headers = Record<string, string>;

interface Principal {
  userId: string;
  headers: (spaceId?: string) => Headers;
  personalSpaceId: string;
}

let ctx: TestContext;
let homeId: string;
let teamId: string;
/** Builder of the home: holds `agents:share` there. */
let author: Principal;
let recipient: Principal;
/** Builder of the team space and of nothing else — no `share` in the home. */
let teamBuilder: Principal;
let teamOperator: Principal;
let teamViewer: Principal;

const owner = (spaceId = homeId): Headers => ({
  Cookie: ctx.cookie,
  "X-Org-Id": ctx.orgId,
  "X-Space-Id": spaceId,
});

/** A member with an optional preset in one space, and their personal space. */
async function principal(space?: {
  id: string;
  preset: "builder" | "viewer" | "operator";
}): Promise<Principal> {
  const user = await createTestUser();
  await addOrgMember(ctx.orgId, user.id, "member");
  if (space) {
    await seedSpaceMember({ spaceId: space.id, userId: user.id, presetRole: space.preset });
  }
  const listed = await app.request("/api/spaces", {
    headers: { Cookie: user.cookie, "X-Org-Id": ctx.orgId },
  });
  expect(listed.status).toBe(200);
  const own = ((await listed.json()) as { data: { id: string; personal: boolean }[] }).data.find(
    (row) => row.personal,
  )!;
  return {
    userId: user.id,
    personalSpaceId: own.id,
    headers: (spaceId = own.id) => ({
      Cookie: user.cookie,
      "X-Org-Id": ctx.orgId,
      "X-Space-Id": spaceId,
    }),
  };
}

const share = (headers: Headers, target: object) =>
  app.request(`/api/packages/${AGENT}/shares`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  });

const withdraw = (headers: Headers, target: string) =>
  app.request(`/api/packages/${AGENT}/shares/${target}`, { method: "DELETE", headers });

const placedIn = async (spaceId: string) =>
  (
    await db
      .select()
      .from(spacePackages)
      .where(and(eq(spacePackages.packageId, AGENT), eq(spacePackages.spaceId, spaceId)))
  ).length > 0;

const scheduleIn = (spaceId: string, userId = ctx.user.id) =>
  seedSchedule({
    packageId: AGENT,
    orgId: ctx.orgId,
    spaceId,
    userId,
    nextRunAt: new Date(Date.now() + 60_000),
  });

const scheduleRow = (id: string) => getDbRow(schedules, eq(schedules.id, id));

const unsharedAudit = () => getDbRow(auditEvents, eq(auditEvents.action, "package.unshared"));

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "withdraw" });
  homeId = (await seedSpace({ orgId: ctx.orgId, name: "Home", visibility: "closed" })).id;
  teamId = (await seedSpace({ orgId: ctx.orgId, name: "Team", visibility: "closed" })).id;
  await seedPackage({
    id: AGENT,
    orgId: ctx.orgId,
    type: "agent",
    homeSpaceId: homeId,
    createdBy: ctx.user.id,
    draftManifest: { name: AGENT, version: "0.1.0", type: "agent", description: "Worker" },
    draftContent: "Do the thing.",
  });
  await seedSpacePackage(homeId, AGENT);
  await seedPublishedVersion(AGENT, "0.1.0");

  author = await principal({ id: homeId, preset: "builder" });
  recipient = await principal();
  teamBuilder = await principal({ id: teamId, preset: "builder" });
  teamOperator = await principal({ id: teamId, preset: "operator" });
  teamViewer = await principal({ id: teamId, preset: "viewer" });
});

describe("the recipient side may withdraw", () => {
  beforeEach(async () => {
    expect(
      (await share(author.headers(homeId), { kind: "user", userId: recipient.userId })).status,
    ).toBe(200);
    expect((await share(owner(), { kind: "space", spaceId: teamId })).status).toBe(200);
  });

  it("from their own personal space, by its id, with no grant at all", async () => {
    const res = await withdraw(recipient.headers(), recipient.personalSpaceId);
    expect(res.status, await res.clone().text()).toBe(204);
    expect(await placedIn(recipient.personalSpaceId)).toBe(false);
    // Audited as its owner, like a `user` target: the space id stays out of the trail.
    expect((await unsharedAudit()).after).toEqual({
      recipientUserId: recipient.userId,
      targetKind: "user",
      authority: "recipient",
    });
  });

  it("from their own personal space, by their user id", async () => {
    const res = await withdraw(recipient.headers(), recipient.userId);
    expect(res.status, await res.clone().text()).toBe(204);
    expect(await placedIn(recipient.personalSpaceId)).toBe(false);
  });

  it("from a team space where they hold the deactivation grant, without `share` in the home", async () => {
    const res = await withdraw(teamBuilder.headers(teamId), teamId);
    expect(res.status, await res.clone().text()).toBe(204);
    expect(await placedIn(teamId)).toBe(false);
    expect((await unsharedAudit()).after).toEqual({
      spaceId: teamId,
      targetKind: "space",
      authority: "recipient",
    });
  });

  it("records the home side when the caller holds `share` there", async () => {
    expect((await withdraw(author.headers(homeId), teamId)).status).toBe(204);
    expect((await unsharedAudit()).after).toMatchObject({ authority: "home" });
  });

  for (const [label, who] of [
    ["an operator", () => teamOperator],
    ["a viewer", () => teamViewer],
  ] as const) {
    it(`refuses ${label} of the target with 403 — reading is not deactivating`, async () => {
      await expectProblem(await withdraw(who().headers(teamId), teamId), 403);
      expect(await placedIn(teamId)).toBe(true);
    });
  }

  it("refuses a team builder withdrawing from a space where they hold nothing (403)", async () => {
    await expectProblem(await withdraw(teamBuilder.headers(teamId), recipient.userId), 403);
    expect(await placedIn(recipient.personalSpaceId)).toBe(true);
  });

  it("answers 404 for somebody else's personal space named by id, even with `share` in the home", async () => {
    await expectProblem(await withdraw(author.headers(homeId), recipient.personalSpaceId), 404);
    expect(await placedIn(recipient.personalSpaceId)).toBe(true);
  });

  it("answers 404 for somebody else's personal space to a caller who cannot reach the package", async () => {
    const stranger = await principal();
    await expectProblem(await withdraw(stranger.headers(), recipient.personalSpaceId), 404);
    expect(await placedIn(recipient.personalSpaceId)).toBe(true);
  });

  it("answers 404 for the home itself — the home placement is not withdrawn here", async () => {
    await expectProblem(await withdraw(author.headers(homeId), homeId), 404);
    expect(await placedIn(homeId)).toBe(true);
  });
});

describe("withdrawing disables the package's schedules in that space", () => {
  beforeEach(async () => {
    expect((await share(owner(), { kind: "space", spaceId: teamId })).status).toBe(200);
  });

  it("disables every schedule there, whoever armed it, and nothing elsewhere", async () => {
    const mine = await scheduleIn(teamId);
    const theirs = await scheduleIn(teamId, teamBuilder.userId);
    const atHome = await scheduleIn(homeId);

    expect((await withdraw(teamBuilder.headers(teamId), teamId)).status).toBe(204);

    for (const id of [mine.id, theirs.id]) {
      expect(await scheduleRow(id)).toMatchObject({
        enabled: false,
        disabledReason: "package_removed",
        nextRunAt: null,
      });
    }
    expect(await scheduleRow(atHome.id)).toMatchObject({ enabled: true, disabledReason: null });
    const after = (await unsharedAudit()).after as { disabledScheduleIds: string[] };
    expect([...after.disabledScheduleIds].sort()).toEqual([mine.id, theirs.id].sort());
  });

  it("rolls the disable back with a refusal: a 404 leaves the schedules armed", async () => {
    expect((await withdraw(owner(), teamId)).status).toBe(204);
    const stray = await scheduleIn(teamId);
    await expectProblem(await withdraw(owner(), teamId), 404);
    expect(await scheduleRow(stray.id)).toMatchObject({ enabled: true });
  });
});

describe("a home move that leaves the old home", () => {
  const move = (keep: boolean) =>
    app.request(`/api/packages/${AGENT}/home`, {
      method: "PUT",
      headers: { ...owner(), "Content-Type": "application/json" },
      body: JSON.stringify({ home_space_id: teamId, keep_in_previous_home: keep }),
    });

  it("`keep: false` withdraws the old home's placement and disables its schedules there", async () => {
    const atOldHome = await scheduleIn(homeId);
    const res = await move(false);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await placedIn(homeId)).toBe(false);
    expect(await scheduleRow(atOldHome.id)).toMatchObject({
      enabled: false,
      disabledReason: "package_removed",
      nextRunAt: null,
    });
    const moved = await getDbRow(auditEvents, eq(auditEvents.action, "package.home_space_changed"));
    expect(moved.after).toMatchObject({
      keptInPreviousHome: false,
      disabledScheduleIds: [atOldHome.id],
    });
  });

  it("`keep: true` leaves the old home's row and its schedules armed", async () => {
    const atOldHome = await scheduleIn(homeId);
    expect((await move(true)).status).toBe(200);
    expect(await placedIn(homeId)).toBe(true);
    expect(await scheduleRow(atOldHome.id)).toMatchObject({ enabled: true });
  });

  it("`keep: true` with no row in the old home still disables its schedules — nothing places it there", async () => {
    await db
      .delete(spacePackages)
      .where(and(eq(spacePackages.packageId, AGENT), eq(spacePackages.spaceId, homeId)));
    const atOldHome = await scheduleIn(homeId);
    expect((await move(true)).status).toBe(200);
    expect(await scheduleRow(atOldHome.id)).toMatchObject({
      enabled: false,
      disabledReason: "package_removed",
    });
    await assertDbMissing(
      spacePackages,
      and(eq(spacePackages.packageId, AGENT), eq(spacePackages.spaceId, homeId))!,
    );
    expect((await getDbRow(packages, eq(packages.id, AGENT))).homeSpaceId).toBe(teamId);
  });
});

describeRequiresRedis("the disabled schedules' jobs", () => {
  afterAll(async () => {
    await flushRedis();
    await closeRedis();
  });

  it("are removed once the withdrawal commits", async () => {
    expect((await share(owner(), { kind: "space", spaceId: teamId })).status).toBe(200);
    const schedule = await createSchedule(
      { orgId: ctx.orgId, spaceId: teamId },
      AGENT,
      { type: "user", id: ctx.user.id },
      { cronExpression: "0 * * * *" },
    );
    const queue = new Queue("schedules", {
      connection: getRedisQueueConnection() as unknown as ConnectionOptions,
    });
    try {
      expect(await queue.getJobScheduler(schedule.id)).toBeDefined();
      expect((await withdraw(owner(), teamId)).status).toBe(204);
      expect(await queue.getJobScheduler(schedule.id)).toBeUndefined();
    } finally {
      await queue.close();
    }
  });
});
