// SPDX-License-Identifier: Apache-2.0

/**
 * The duration a metering module settles a run from (`runs.duration`, read through
 * `PlatformServices.runs.listTerminal`) for the runs the PLATFORM terminates itself: the stall
 * and boot-deadline watchdogs, a cancel, an orphan found at boot. None of those carry a runner
 * `durationMs`, so the fallback decides what a run is worth: it must start when the run left
 * `pending` (`runs.running_at`), never at the creation of the row, and a run that never ran
 * lasted 0. The projection also caps it at the platform's timeout ceiling.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { encrypt } from "@appstrate/connect";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { runWatchdogTick } from "../../../src/services/run-watchdog.ts";
import { synthesiseFinalize } from "../../../src/services/run-event-ingestion.ts";
import { listTerminalRuns, updateRun } from "../../../src/services/state/runs.ts";
import { _setRunLimitsForTesting } from "../../../src/services/run-limits.ts";

getTestApp();

const MIN = 60_000;
const HOUR = 60 * MIN;
const CEILING_SECONDS = 1800;

describe("duration of a run the platform terminates", () => {
  let ctx: TestContext;

  async function seed(overrides: {
    status: "pending" | "running";
    startedAt: Date;
    runningAt: Date | null;
    lastHeartbeatAt?: Date;
    bootDeadlineAt?: Date | null;
    lastEventSequence?: number;
  }): Promise<string> {
    const id = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.insert(runs).values({
      id,
      packageId: "@test/dur-agent",
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      status: overrides.status,
      runOrigin: "remote",
      sinkSecretEncrypted: encrypt("a".repeat(43)),
      sinkExpiresAt: new Date(Date.now() + HOUR),
      startedAt: overrides.startedAt,
      runningAt: overrides.runningAt,
      lastHeartbeatAt: overrides.lastHeartbeatAt ?? new Date(),
      bootDeadlineAt: overrides.bootDeadlineAt ?? new Date(Date.now() + 5 * MIN),
      lastEventSequence: overrides.lastEventSequence ?? 1,
    });
    return id;
  }

  const tick = () =>
    runWatchdogTick({ intervalSeconds: 30, stallThresholdSeconds: 60, maxFinalizesPerTick: 100 });

  async function durationOf(id: string): Promise<number | null> {
    const [row] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
    return row?.duration ?? null;
  }

  beforeEach(async () => {
    await truncateAll();
    _setRunLimitsForTesting({ timeout_ceiling_seconds: CEILING_SECONDS });
    ctx = await createTestContext({ email: "dur@test.dev", orgSlug: "dur-org" });
    await seedPackage({ orgId: ctx.orgId, id: "@test/dur-agent", type: "agent" });
  });

  it("measures a stalled run from when it started running, not from its creation", async () => {
    // Created 4 hours ago, running for 3 minutes before the runner went silent.
    const id = await seed({
      status: "running",
      startedAt: new Date(Date.now() - 4 * HOUR),
      runningAt: new Date(Date.now() - 3 * MIN),
      lastHeartbeatAt: new Date(Date.now() - 2 * MIN),
    });

    expect(await tick()).toBe(1);

    const duration = (await durationOf(id))!;
    expect(duration).toBeGreaterThan(3 * MIN - 5_000);
    expect(duration).toBeLessThan(3 * MIN + 30_000);
  });

  it("counts a run that blew its provisioning deadline for nothing", async () => {
    const id = await seed({
      status: "pending",
      startedAt: new Date(Date.now() - 6 * MIN),
      runningAt: null,
      lastEventSequence: 0,
      bootDeadlineAt: new Date(Date.now() - 10_000),
    });

    expect(await tick()).toBe(1);

    expect(await durationOf(id)).toBe(0);
  });

  it("counts a run cancelled while still queued for nothing", async () => {
    const id = await seed({
      status: "pending",
      startedAt: new Date(Date.now() - 20_000),
      runningAt: null,
      lastEventSequence: 0,
    });

    await synthesiseFinalize(id, { status: "cancelled", error: { message: "Cancelled by user" } });

    expect(await durationOf(id)).toBe(0);
  });

  it("prefers the duration the runner measured", async () => {
    const id = await seed({
      status: "running",
      startedAt: new Date(Date.now() - 4 * HOUR),
      runningAt: new Date(Date.now() - 3 * HOUR),
    });

    await synthesiseFinalize(id, { status: "success", durationMs: 42_000 });

    expect(await durationOf(id)).toBe(42_000);
  });

  it("caps what the projection reports at the platform's timeout ceiling", async () => {
    // An orphan finalized at the next boot, hours after the server went down: the recorded
    // duration is honest wall-clock time, but no run may be billed longer than it could last.
    const id = await seed({
      status: "running",
      startedAt: new Date(Date.now() - 5 * HOUR),
      runningAt: new Date(Date.now() - 4 * HOUR),
    });

    await synthesiseFinalize(id, {
      status: "failed",
      error: { message: "Server restarted while run was in progress. Please retry." },
    });

    expect((await durationOf(id))!).toBeGreaterThan(CEILING_SECONDS * 1000);
    const [row] = await listTerminalRuns({});
    expect(row!.id).toBe(id);
    expect(row!.durationMs).toBe(CEILING_SECONDS * 1000);
  });

  it("stamps running_at once, at the first flip to running", async () => {
    const id = await seed({
      status: "pending",
      startedAt: new Date(),
      runningAt: null,
      lastEventSequence: 0,
    });
    const scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };

    await updateRun(scope, id, { status: "running" });
    const [first] = await db.select().from(runs).where(eq(runs.id, id));
    expect(first!.runningAt).not.toBeNull();

    await new Promise((r) => setTimeout(r, 20));
    await updateRun(scope, id, { status: "running" });
    const [second] = await db.select().from(runs).where(eq(runs.id, id));
    expect(second!.runningAt!.getTime()).toBe(first!.runningAt!.getTime());
  });
});
