// SPDX-License-Identifier: Apache-2.0

/**
 * A package that is switched off does not run — on the cron path too.
 *
 * The scheduler tick is the one execution path with no caller to refuse: it
 * fires on its own, under an actor frozen at create time. Deactivating an agent
 * therefore has to stop it HERE, or "switch this agent off for a week" is a
 * cosmetic filter on the pages a human looks at while the agent keeps running
 * on the space's credentials and the organization's LLM budget.
 *
 * Whether a space runs a package is a property of the SPACE, re-read at fire
 * time — unlike the actor's draft authority or the frozen connection
 * overrides, which are properties of the principal and settled when they proved
 * them. The integration activation gate in readiness already works this way.
 *
 * PLACEMENT is the other half, and it is re-read here for the same reason: the
 * tick and the three HTTP doors ask ONE predicate
 * (`agentExecutionBlock` — placed here AND active here), so an orphan
 * `space_packages` row with neither a home nor a share behind it cannot keep
 * firing from a cron in a space every request-borne door already refuses.
 *
 * Tier 0: `triggerScheduledRun` is called directly, so none of this needs the
 * real BullMQ repeatable-job semantics the sibling suite waits for Redis on.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, runs, schedules } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageShare, seedSpace, seedSpacePackage } from "../../helpers/seed.ts";
import { deactivatePackage, activatePackage } from "../../../src/services/space-packages.ts";
import { createSchedule, triggerScheduledRun } from "../../../src/services/scheduler.ts";
import type { Actor } from "../../../src/lib/actor.ts";

getTestApp();

const AGENT = "@sched/worker";

let ctx: TestContext;
let actor: Actor;
let scheduleId: string;

/** Every run row the schedule has produced, oldest first. */
async function runsOfSchedule() {
  const rows = await db.select().from(runs).where(eq(runs.scheduleId, scheduleId));
  return rows.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
}

async function fire() {
  await triggerScheduledRun(scheduleId, AGENT, actor, ctx.orgId, ctx.defaultSpaceId, undefined, {
    // The agent is a never-published draft; `draft` is what the schedule's
    // author selected, so version resolution is not what this suite measures.
    versionOverride: "draft",
  });
}

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext();
  actor = { type: "user", id: ctx.user.id };
  await seedPackage({
    id: AGENT,
    orgId: ctx.orgId,
    homeSpaceId: ctx.defaultSpaceId,
    draftManifest: { name: AGENT, version: "0.1.0", type: "agent", description: "Scheduled" },
  });
  await seedSpacePackage(ctx.defaultSpaceId, AGENT);
  const schedule = await createSchedule(
    { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
    AGENT,
    actor,
    {
      cronExpression: "0 3 * * *",
      versionOverride: "draft",
    },
  );
  scheduleId = schedule.id;
});

describe("the scheduler tick reads the activation, like every other execution door", () => {
  it("refuses to launch a deactivated agent, visibly, and leaves the schedule ARMED", async () => {
    await deactivatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);

    await fire();

    // A refusal is a VISIBLE failed run, not a silent skip (issue #735): the
    // operator has no request to read a status code from.
    const after = await runsOfSchedule();
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("failed");
    expect(after[0]!.error).toContain("is not active in space");
    expect(after[0]!.error).toContain(`/api/spaces/${ctx.defaultSpaceId}/packages`);

    // ARMED, deliberately — this is NOT the invalid-actor channel, which also
    // disables the schedule. An actor who left the organization is not coming
    // back; an agent that was switched off can be switched on again, and the
    // next tick must then run it.
    const [row] = await db.select().from(schedules).where(eq(schedules.id, scheduleId));
    expect(row!.enabled).toBe(true);
    expect(row!.nextRunAt).not.toBeNull();
  });

  it("launches again once the agent is reactivated — same schedule, next tick", async () => {
    await deactivatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);
    await fire();
    expect((await runsOfSchedule())[0]!.error).toContain("is not active in space");

    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);
    await fire();

    const all = await runsOfSchedule();
    expect(all).toHaveLength(2);
    // The second fire got PAST the gate. It may still fail downstream (tier 0
    // has no model to reach), which is exactly why the assertion is about the
    // cause and not about the status.
    expect(all[1]!.error ?? "").not.toContain("is not active in space");
  });

  it("launches an ACTIVE agent — the control that makes the refusal mean something", async () => {
    await fire();
    const all = await runsOfSchedule();
    expect(all).toHaveLength(1);
    expect(all[0]!.error ?? "").not.toContain("is not active in space");
    expect(all[0]!.error ?? "").not.toContain("is not placed in space");
  });

  it("refuses an ORPHAN placement — a row with neither a home nor a share", async () => {
    // The pre-0016 residue, reproduced exactly: the agent is homed in ANOTHER
    // space, the scheduled space holds an enabled `space_packages` row, and no
    // `package_shares` row ever authorized it. The activation question alone
    // answers "yes" here — the row says `enabled` — so this is precisely the
    // state the placement half of the gate exists to refuse.
    const elsewhere = await seedSpace({ orgId: ctx.orgId, name: "Elsewhere" });
    await db.update(packages).set({ homeSpaceId: elsewhere.id }).where(eq(packages.id, AGENT));

    await fire();

    const after = await runsOfSchedule();
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("failed");
    // The refusal names PLACEMENT, not the switch: sharing the agent into the
    // space is the repair, and "activate it" would send the operator to a page
    // that cannot show them this agent at all.
    expect(after[0]!.error).toContain("is not placed in space");
    expect(after[0]!.error).not.toContain("is not active in space");

    // ARMED, like the deactivation refusal: an offer can be made again.
    const [row] = await db.select().from(schedules).where(eq(schedules.id, scheduleId));
    expect(row!.enabled).toBe(true);
    expect(row!.nextRunAt).not.toBeNull();
  });

  it("launches once the missing SHARE is written — the placement half, isolated", async () => {
    // Same fixture as above, plus the one row that was missing. Nothing else
    // changes: the `space_packages` row was already enabled throughout, so a
    // second fire that gets past the gate can only be the placement half
    // answering differently.
    const elsewhere = await seedSpace({ orgId: ctx.orgId, name: "Elsewhere" });
    await db.update(packages).set({ homeSpaceId: elsewhere.id }).where(eq(packages.id, AGENT));
    await fire();
    expect((await runsOfSchedule())[0]!.error).toContain("is not placed in space");

    await seedPackageShare(ctx.defaultSpaceId, AGENT);
    await fire();

    const all = await runsOfSchedule();
    expect(all).toHaveLength(2);
    expect(all[1]!.error ?? "").not.toContain("is not placed in space");
    expect(all[1]!.error ?? "").not.toContain("is not active in space");
  });
});
