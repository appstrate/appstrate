// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `recordBootHeartbeat` — the synthetic boot-window
 * keep-alive the Firecracker remote backend pumps so the stall watchdog
 * does not kill a slow-booting microVM before its guest posts its first
 * sink event.
 *
 * The gating (`last_event_sequence = 0 AND sink_closed_at IS NULL AND the
 * boot deadline has not passed`) is what stops a synthetic heartbeat from
 * masking a run that has ALREADY emitted events, whose sink has closed, or
 * whose provisioning is wedged. These tests exercise that gate against a
 * real DB row (not a fake), covering every outcome:
 *   - fresh run (seq 0, sink open)      → "bumped" (heartbeat advances)
 *   - run that has emitted events (seq>0) → "guest-active" (no advance)
 *   - run whose sink is closed          → "closed" (no advance)
 *   - run past its boot deadline        → "deadline-passed" (no advance)
 *   - unknown runId                     → "closed"
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
import { recordBootHeartbeat, createRun } from "../../../src/services/state/runs.ts";

// Boot the test app once so DB migrations are applied.
getTestApp();

const RUN_SECRET = "a".repeat(43);

async function seedRun(
  ctx: TestContext,
  packageId: string,
  overrides: {
    lastHeartbeatAt?: Date;
    lastEventSequence?: number;
    sinkClosedAt?: Date | null;
    bootDeadlineAt?: Date | null;
  } = {},
): Promise<string> {
  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(runs).values({
    id: runId,
    packageId,
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    status: "running",
    runOrigin: "remote",
    sinkSecretEncrypted: encrypt(RUN_SECRET),
    sinkExpiresAt: new Date(Date.now() + 3600_000),
    sinkClosedAt: overrides.sinkClosedAt ?? null,
    startedAt: new Date(),
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? new Date(),
    lastEventSequence: overrides.lastEventSequence ?? 0,
    bootDeadlineAt:
      "bootDeadlineAt" in overrides ? overrides.bootDeadlineAt : new Date(Date.now() + 300_000),
  });
  return runId;
}

async function readHeartbeat(runId: string): Promise<Date | null> {
  const [row] = await db
    .select({ lastHeartbeatAt: runs.lastHeartbeatAt })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  return row?.lastHeartbeatAt ?? null;
}

describe("recordBootHeartbeat — boot-window synthetic keep-alive gating", () => {
  let ctx: TestContext;
  const agentId = "@test/boot-heartbeat-agent";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ email: "boot-hb@test.dev", orgSlug: "boot-hb-org" });
    await seedPackage({ orgId: ctx.orgId, id: agentId, type: "agent" });
  });

  it("bumps last_heartbeat_at for a fresh run (seq 0, sink open)", async () => {
    const seeded = new Date(Date.now() - 120_000); // 2 minutes ago
    const runId = await seedRun(ctx, agentId, { lastHeartbeatAt: seeded });

    const outcome = await recordBootHeartbeat(runId);

    expect(outcome).toBe("bumped");
    // The heartbeat must actually have advanced — read it back and assert
    // it moved forward from the seeded past value.
    const after = await readHeartbeat(runId);
    expect(after).not.toBeNull();
    expect(after!.getTime()).toBeGreaterThan(seeded.getTime());
  });

  it("returns guest-active without advancing the heartbeat once events have landed", async () => {
    const seeded = new Date(Date.now() - 120_000);
    const runId = await seedRun(ctx, agentId, {
      lastHeartbeatAt: seeded,
      lastEventSequence: 1,
    });

    const outcome = await recordBootHeartbeat(runId);

    expect(outcome).toBe("guest-active");
    // The gate excluded this row, so the heartbeat must be untouched.
    const after = await readHeartbeat(runId);
    expect(after!.getTime()).toBe(seeded.getTime());
  });

  it("returns closed without advancing the heartbeat once the sink is closed", async () => {
    const seeded = new Date(Date.now() - 120_000);
    const runId = await seedRun(ctx, agentId, {
      lastHeartbeatAt: seeded,
      sinkClosedAt: new Date(),
    });

    const outcome = await recordBootHeartbeat(runId);

    expect(outcome).toBe("closed");
    const after = await readHeartbeat(runId);
    expect(after!.getTime()).toBe(seeded.getTime());
  });

  it("refuses to vouch for a run past its boot deadline", async () => {
    // The anti-abuse gate: a provisioner wedged on a hung daemon call would
    // otherwise keep bumping forever and the run would never terminate.
    const seeded = new Date(Date.now() - 120_000);
    const runId = await seedRun(ctx, agentId, {
      lastHeartbeatAt: seeded,
      bootDeadlineAt: new Date(Date.now() - 1_000),
    });

    const outcome = await recordBootHeartbeat(runId);

    expect(outcome).toBe("deadline-passed");
    const after = await readHeartbeat(runId);
    expect(after!.getTime()).toBe(seeded.getTime());
  });

  it("still bumps a pre-migration row that has no boot deadline", async () => {
    const seeded = new Date(Date.now() - 120_000);
    const runId = await seedRun(ctx, agentId, {
      lastHeartbeatAt: seeded,
      bootDeadlineAt: null,
    });

    const outcome = await recordBootHeartbeat(runId);

    expect(outcome).toBe("bumped");
    const after = await readHeartbeat(runId);
    expect(after!.getTime()).toBeGreaterThan(seeded.getTime());
  });

  it("returns closed for an unknown runId", async () => {
    const outcome = await recordBootHeartbeat("run_does_not_exist_00");
    expect(outcome).toBe("closed");
  });

  // The gate above is only worth anything if every row the watchdog can
  // reach actually carries a deadline. `createRun` derives it from the env
  // whenever a sink is opened, on every creation path (platform + remote),
  // so no caller can forget it or widen it.
  it("stamps a boot deadline on every run created with an open sink", async () => {
    const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const before = Date.now();
    await createRun(
      { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      {
        id: runId,
        packageId: agentId,
        actor: { type: "user", id: ctx.user.id },
        input: null,
        sinkSecretEncrypted: encrypt(RUN_SECRET),
        sinkExpiresAt: new Date(Date.now() + 3600_000),
      },
    );

    const [row] = await db
      .select({ bootDeadlineAt: runs.bootDeadlineAt })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    expect(row?.bootDeadlineAt).not.toBeNull();
    // Default budget is 300s; assert the ballpark rather than the exact ms
    // (the stamp happens a few ms after `before` was sampled).
    const budgetSeconds = (row!.bootDeadlineAt!.getTime() - before) / 1000;
    expect(budgetSeconds).toBeGreaterThan(280);
    expect(budgetSeconds).toBeLessThan(320);
  });

  it("leaves the boot deadline null for a run created without a sink", async () => {
    // No sink means no watchdog eligibility at all — a deadline would be
    // meaningless (and the sweep filters on an open sink anyway).
    const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await createRun(
      { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      {
        id: runId,
        packageId: agentId,
        actor: { type: "user", id: ctx.user.id },
        input: null,
      },
    );

    const [row] = await db
      .select({ bootDeadlineAt: runs.bootDeadlineAt })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    expect(row?.bootDeadlineAt).toBeNull();
  });
});
