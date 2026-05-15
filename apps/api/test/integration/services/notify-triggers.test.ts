// SPDX-License-Identifier: Apache-2.0

/**
 * Regression: validate that the NOTIFY trigger functions installed by
 * `createNotifyTriggers` reference columns that actually exist on the
 * `runs` / `run_logs` tables.
 *
 * Pre-existing realtime tests fire `pg_notify(...)` directly via
 * `db.execute()` — they never exercise the trigger function body, so a
 * dangling column reference (e.g. `NEW.user_id` after the column is
 * split/renamed) is invisible to them and only surfaces at runtime on the
 * first real INSERT/UPDATE.
 *
 * These tests install the triggers, then perform a real INSERT + UPDATE on
 * `runs` (and INSERT on `run_logs`) to force Postgres to evaluate the
 * trigger function bodies against the current schema.
 */

import { describe, it, beforeAll, afterAll, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../../helpers/db.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createNotifyTriggers } from "@appstrate/db/notify";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun, seedRunLog } from "../../helpers/seed.ts";

describe("NOTIFY triggers (regression)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    await createNotifyTriggers(db);
  });

  // Drop the triggers we installed so they do not leak to other test files.
  // The full suite (`bun test`) runs every file in a single Bun process; without
  // this teardown, run-metric-broadcaster + run-metric-streaming + persisting-event-sink
  // see runs_notify_trigger firing on every UPDATE the broadcaster issues to
  // persist `cost`, deliver an extra `run_update` event to their subscribers,
  // and trip `toHaveBeenCalledTimes(N)` assertions by one. The leak is order-
  // sensitive (Bun's per-file ordering is not strict alphabetical) which is
  // why CI flaked while local runs sometimes passed.
  afterAll(async () => {
    await db.execute(sql`DROP TRIGGER IF EXISTS runs_notify_trigger ON runs`);
    await db.execute(sql`DROP TRIGGER IF EXISTS run_logs_notify_trigger ON run_logs`);
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "notifyorg" });
    await seedAgent({
      id: "@notifyorg/trigger-agent",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });
  });

  it("notify_run_change fires on INSERT without referencing removed columns", async () => {
    // Must not throw: `record "new" has no field "user_id"` if trigger is stale.
    await seedRun({
      packageId: "@notifyorg/trigger-agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status: "pending",
    });
  });

  it("notify_run_change fires on UPDATE", async () => {
    const run = await seedRun({
      packageId: "@notifyorg/trigger-agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status: "pending",
    });
    // A status transition is what production hits on every run lifecycle step.
    await db.execute(
      (await import("drizzle-orm")).sql`UPDATE runs SET status = 'running' WHERE id = ${run.id}`,
    );
  });

  it("notify_run_log_insert fires on run_logs INSERT", async () => {
    const run = await seedRun({
      packageId: "@notifyorg/trigger-agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status: "running",
    });
    await seedRunLog({
      runId: run.id,
      orgId: ctx.orgId,
      level: "info",
      message: "trigger smoke test",
    });
  });
});
