// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `recordBootHeartbeat` — the synthetic boot-window
 * keep-alive the Firecracker remote backend pumps so the stall watchdog
 * does not kill a slow-booting microVM before its guest posts its first
 * sink event.
 *
 * The 3-way gating (`last_event_sequence = 0 AND sink_closed_at IS NULL`)
 * is what stops a synthetic heartbeat from masking a run that has ALREADY
 * emitted events or whose sink has closed. These tests exercise that gate
 * against a real DB row (not a fake), covering every outcome:
 *   - fresh run (seq 0, sink open)      → "bumped" (heartbeat advances)
 *   - run that has emitted events (seq>0) → "guest-active" (no advance)
 *   - run whose sink is closed          → "closed" (no advance)
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
import { recordBootHeartbeat } from "../../../src/services/state/runs.ts";

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
  } = {},
): Promise<string> {
  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(runs).values({
    id: runId,
    packageId,
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    status: "running",
    runOrigin: "remote",
    sinkSecretEncrypted: encrypt(RUN_SECRET),
    sinkExpiresAt: new Date(Date.now() + 3600_000),
    sinkClosedAt: overrides.sinkClosedAt ?? null,
    startedAt: new Date(),
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? new Date(),
    lastEventSequence: overrides.lastEventSequence ?? 0,
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

  it("returns closed for an unknown runId", async () => {
    const outcome = await recordBootHeartbeat("run_does_not_exist_00");
    expect(outcome).toBe("closed");
  });
});
