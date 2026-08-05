// SPDX-License-Identifier: Apache-2.0

/**
 * The run counters served WITH each schedule: `running_runs`, `unread_count`
 * and `last_run_number`.
 *
 * They exist to kill an N+1: the schedule card used to fetch
 * `GET /api/schedules/:id/runs` per row just to count these three things, so a
 * dashboard listing N schedules issued N extra requests. What has to hold for
 * that replacement to be honest:
 *
 *  - the counts are RIGHT, including across more runs than the per-card fetch
 *    used to page through (its page size was 20, so a schedule with more unread
 *    runs than that under-reported);
 *  - `unread_count` follows the VIEWER, not the schedule's execution actor —
 *    two members looking at the same schedule must see their own read state,
 *    exactly like `EnrichedRun.unread`;
 *  - the counts stay inside the tenant: another org's runs, or another
 *    schedule's runs, never leak into a schedule's totals.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { notifications } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  addOrgMember,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedAgent, seedSchedule, seedRun } from "../../helpers/seed.ts";
import type { RunStatus } from "@appstrate/shared-types";

const app = getTestApp();

interface ScheduleWithStats {
  id: string;
  running_runs: number;
  unread_count: number;
  last_run_number: number;
}

describe("Schedule run counters", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  /** Seed a schedule owned by `ctx.user` on a fresh agent. */
  async function seedAgentSchedule(name: string) {
    const agent = await seedAgent({ id: `@${ctx.org.slug}/${name}`, orgId: ctx.orgId });
    return seedSchedule({
      packageId: agent.id,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      name,
    });
  }

  async function seedScheduleRun(
    scheduleId: string,
    packageId: string,
    status: RunStatus,
    runNumber: number,
  ) {
    return seedRun({
      packageId,
      scheduleId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status,
      runNumber,
    });
  }

  /** An UNREAD notification for `recipient` about `runId`. */
  async function seedUnread(runId: string, recipientId: string) {
    await db.insert(notifications).values({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      recipientType: "user",
      recipientId,
      runId,
      type: "run_completed",
    });
  }

  async function listSchedules(context: TestContext): Promise<ScheduleWithStats[]> {
    const res = await app.request("/api/schedules", { headers: authHeaders(context) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: ScheduleWithStats[] };
    return body.data;
  }

  it("reports zeroes for a schedule that never fired", async () => {
    await seedAgentSchedule("never-fired");

    const [schedule] = await listSchedules(ctx);
    expect(schedule).toBeDefined();
    expect(schedule!.running_runs).toBe(0);
    expect(schedule!.unread_count).toBe(0);
    expect(schedule!.last_run_number).toBe(0);
  });

  it("counts active runs, unread runs and the highest run number", async () => {
    const schedule = await seedAgentSchedule("busy");

    // 2 active (pending + running), 2 terminal.
    const r1 = await seedScheduleRun(schedule.id, schedule.packageId, "pending", 1);
    const r2 = await seedScheduleRun(schedule.id, schedule.packageId, "running", 2);
    const r3 = await seedScheduleRun(schedule.id, schedule.packageId, "success", 3);
    await seedScheduleRun(schedule.id, schedule.packageId, "failed", 4);

    // 3 notifications, one of them already read.
    await seedUnread(r1.id, ctx.user.id);
    await seedUnread(r2.id, ctx.user.id);
    await db.insert(notifications).values({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      recipientType: "user",
      recipientId: ctx.user.id,
      runId: r3.id,
      type: "run_completed",
      readAt: new Date(),
    });

    const [enriched] = await listSchedules(ctx);
    expect(enriched!.running_runs).toBe(2);
    expect(enriched!.unread_count).toBe(2);
    expect(enriched!.last_run_number).toBe(4);
  });

  // The per-card fetch this replaces asked for 20 runs and counted within them.
  it("counts across the WHOLE history, not one page of runs", async () => {
    const schedule = await seedAgentSchedule("long-history");

    for (let i = 1; i <= 25; i++) {
      const run = await seedScheduleRun(schedule.id, schedule.packageId, "success", i);
      await seedUnread(run.id, ctx.user.id);
    }

    const [enriched] = await listSchedules(ctx);
    expect(enriched!.unread_count).toBe(25);
    expect(enriched!.last_run_number).toBe(25);
  });

  it("scopes unread_count to the VIEWER, not to the schedule's actor", async () => {
    const schedule = await seedAgentSchedule("shared");
    const run = await seedScheduleRun(schedule.id, schedule.packageId, "success", 1);

    // The schedule's own actor has an unread notification; a second member of
    // the same org does not.
    await seedUnread(run.id, ctx.user.id);

    const other = await createTestUser();
    await addOrgMember(ctx.orgId, other.id, "admin");
    const otherCtx: TestContext = { ...ctx, user: other, cookie: other.cookie };

    const [asOwner] = await listSchedules(ctx);
    const [asOther] = await listSchedules(otherCtx);

    expect(asOwner!.unread_count).toBe(1);
    expect(asOther!.unread_count).toBe(0);
    // Everything that is NOT recipient-scoped stays identical between viewers.
    expect(asOther!.running_runs).toBe(asOwner!.running_runs);
    expect(asOther!.last_run_number).toBe(asOwner!.last_run_number);
  });

  it("never counts another schedule's runs", async () => {
    const a = await seedAgentSchedule("sched-a");
    const b = await seedAgentSchedule("sched-b");

    await seedScheduleRun(a.id, a.packageId, "running", 1);
    await seedScheduleRun(b.id, b.packageId, "running", 7);
    await seedScheduleRun(b.id, b.packageId, "running", 8);

    const schedules = await listSchedules(ctx);
    const byId = new Map(schedules.map((s) => [s.id, s]));
    expect(byId.get(a.id)!.running_runs).toBe(1);
    expect(byId.get(a.id)!.last_run_number).toBe(1);
    expect(byId.get(b.id)!.running_runs).toBe(2);
    expect(byId.get(b.id)!.last_run_number).toBe(8);
  });

  it("serves the same counters on the schedule detail endpoint", async () => {
    const schedule = await seedAgentSchedule("detail");
    const run = await seedScheduleRun(schedule.id, schedule.packageId, "running", 3);
    await seedUnread(run.id, ctx.user.id);

    const res = await app.request(`/api/schedules/${schedule.id}`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ScheduleWithStats;
    expect(body.running_runs).toBe(1);
    expect(body.unread_count).toBe(1);
    expect(body.last_run_number).toBe(3);
  });
});
