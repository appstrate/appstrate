// SPDX-License-Identifier: Apache-2.0

/**
 * Settlement of compute minutes: finished runs, read through the mock
 * `PlatformServices.runs.listTerminal`, become the org's monthly counter. Pins the contract:
 * rounded up to the second, a remote run counted for nothing, each run counted ONCE however
 * often it is re-read, the month boundary starting a fresh counter, a bounded replay window
 * for runs that commit late, a failed pass advancing nothing, and the 80 % warning email.
 */
import { describe, expect, it, beforeEach, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { getBillingDb, truncateBillingTables } from "../../helpers/db.ts";
import {
  seedBillingAccount,
  seedComputeCursor,
  seedComputeUsage,
  seedTerminalRun,
} from "../../helpers/seed.ts";
import {
  releaseMockRunsHang,
  setMockRunsError,
  setMockRunsHang,
} from "../../helpers/mock-platform.ts";
import { seedOrgMembers } from "../../helpers/org-queries.ts";
import { useBillingTestSeams } from "../../helpers/setup.ts";
import {
  _awaitSettlementForTests,
  drainComputeSweeper,
  startComputeSweeper,
  stopComputeSweeper,
  ensureComputeCursorSeeded,
  REPLAY_WINDOW_MS,
  requestSettlement,
  settleTerminalRuns,
} from "../../../src/compute/settlement.ts";
import { cancelSubscriptionAndCleanUp } from "../../../src/billing/org-cancellation.ts";
import { readComputeSecondsUsed } from "../../../src/compute/usage.ts";
import { periodStartOf } from "../../../src/compute/period.ts";
import { initBillingEmail } from "../../../src/emails/send.ts";
import { emitComputeSignals } from "../../../src/compute/alerts.ts";
import { logger } from "../../../src/logger.ts";
import { computeCursor, computeUsage, settledRuns } from "../../../drizzle/schema.ts";
import billingModule from "../../../src/index.ts";

useBillingTestSeams();

const orgId = "00000000-0000-4000-a000-000000000a01";
const otherOrg = "00000000-0000-4000-a000-000000000a02";
const NOW = new Date();
const THIS_MONTH = periodStartOf(NOW);

async function secondsUsed(org = orgId): Promise<number> {
  return readComputeSecondsUsed(org, NOW);
}

async function cursorRow() {
  const [row] = await getBillingDb().select().from(computeCursor);
  return row!;
}

describe("settleTerminalRuns", () => {
  beforeEach(async () => {
    await truncateBillingTables();
    await seedComputeCursor();
  });

  it("counts a 40 second run as 40 seconds of the quota", async () => {
    seedTerminalRun({ orgId, id: "run_40s", durationMs: 40_000, completedAt: NOW });

    const result = await settleTerminalRuns();

    expect(result).toEqual({ read: 1, settled: 1, seconds: 40 });
    expect(await secondsUsed()).toBe(40);
  });

  it("rounds each run up to the second and adds them", async () => {
    seedTerminalRun({ orgId, durationMs: 400, completedAt: new Date(NOW.getTime() + 1) });
    seedTerminalRun({ orgId, durationMs: 1_001, completedAt: new Date(NOW.getTime() + 2) });
    seedTerminalRun({ orgId, durationMs: 59_000, completedAt: new Date(NOW.getTime() + 3) });

    await settleTerminalRuns();

    expect(await secondsUsed()).toBe(1 + 2 + 59);
  });

  it("counts failed, timed out and cancelled runs for the time they consumed", async () => {
    seedTerminalRun({ orgId, status: "failed", durationMs: 10_000, completedAt: NOW });
    seedTerminalRun({
      orgId,
      status: "timeout",
      durationMs: 300_000,
      completedAt: new Date(NOW.getTime() + 1),
    });
    seedTerminalRun({
      orgId,
      status: "cancelled",
      durationMs: 5_000,
      completedAt: new Date(NOW.getTime() + 2),
    });

    await settleTerminalRuns();

    expect(await secondsUsed()).toBe(315);
  });

  it("claims a remote run but counts nothing for it", async () => {
    seedTerminalRun({
      orgId,
      id: "run_remote",
      runOrigin: "remote",
      durationMs: 3_600_000,
      completedAt: NOW,
    });

    const result = await settleTerminalRuns();

    expect(result).toEqual({ read: 1, settled: 1, seconds: 0 });
    expect(await secondsUsed()).toBe(0);
    const [claim] = await getBillingDb().select().from(settledRuns);
    expect(claim).toMatchObject({ runId: "run_remote", seconds: 0 });
  });

  it("counts each run once however many times it is read", async () => {
    seedTerminalRun({ orgId, durationMs: 30_000, completedAt: NOW });

    await settleTerminalRuns();
    const again = await settleTerminalRuns();
    // A rewound watermark re-reads everything: still nothing more to count.
    await seedComputeCursor();
    const rewound = await settleTerminalRuns();

    expect(again.settled).toBe(0);
    expect(rewound.read).toBe(1);
    expect(rewound.settled).toBe(0);
    expect(await secondsUsed()).toBe(30);
  });

  it("keeps each org's counter apart", async () => {
    seedTerminalRun({ orgId, durationMs: 10_000, completedAt: NOW });
    seedTerminalRun({
      orgId: otherOrg,
      durationMs: 25_000,
      completedAt: new Date(NOW.getTime() + 1),
    });

    await settleTerminalRuns();

    expect(await secondsUsed(orgId)).toBe(10);
    expect(await secondsUsed(otherOrg)).toBe(25);
  });

  it("counts a run in the month it completed, so the next month starts from zero", async () => {
    const lastMonth = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 15));
    seedTerminalRun({ orgId, durationMs: 90_000, completedAt: lastMonth });
    seedTerminalRun({ orgId, durationMs: 20_000, completedAt: NOW });
    // The watermark sits before both: this is a late settlement across a month boundary.
    await settleTerminalRuns({ replayWindowMs: 0 });

    const rows = await getBillingDb().select().from(computeUsage);
    const byPeriod = Object.fromEntries(rows.map((r) => [r.periodStart, r.secondsUsed]));
    expect(byPeriod[periodStartOf(lastMonth)]).toBe(90);
    expect(byPeriod[THIS_MONTH]).toBe(20);
    expect(await secondsUsed()).toBe(20);
  });

  it("pages through a backlog larger than one batch", async () => {
    for (let i = 0; i < 5; i++) {
      seedTerminalRun({ orgId, durationMs: 1_000, completedAt: new Date(NOW.getTime() + i) });
    }

    const result = await settleTerminalRuns({ batchSize: 2 });

    expect(result).toEqual({ read: 5, settled: 5, seconds: 5 });
    expect(await secondsUsed()).toBe(5);
  });

  it("stops at maxBatches and the next pass carries on", async () => {
    for (let i = 0; i < 5; i++) {
      seedTerminalRun({ orgId, durationMs: 1_000, completedAt: new Date(NOW.getTime() + i) });
    }

    const first = await settleTerminalRuns({ batchSize: 2, maxBatches: 1, replayWindowMs: 0 });
    expect(first.settled).toBe(2);
    const second = await settleTerminalRuns({ batchSize: 10, replayWindowMs: 0 });
    expect(second.settled).toBe(3);
    expect(await secondsUsed()).toBe(5);
  });

  it("only moves the watermark forward", async () => {
    const late = new Date(NOW.getTime() + 5_000);
    seedTerminalRun({ orgId, id: "run_late", durationMs: 1_000, completedAt: late });
    await settleTerminalRuns();
    expect((await cursorRow()).completedAt.getTime()).toBe(late.getTime());

    // An older run committing afterwards is settled but must not pull the watermark back.
    seedTerminalRun({
      orgId,
      id: "run_older",
      durationMs: 1_000,
      completedAt: new Date(late.getTime() - 1_000),
    });
    await settleTerminalRuns();

    expect((await cursorRow()).completedAt.getTime()).toBe(late.getTime());
    expect((await cursorRow()).runId).toBe("run_late");
  });

  it("recovers a run that committed below the watermark, within the replay window", async () => {
    seedTerminalRun({
      orgId,
      id: "run_head",
      durationMs: 5_000,
      completedAt: new Date(NOW.getTime() + 10_000),
    });
    await settleTerminalRuns();

    // Its completed_at predates the head but it only became visible now.
    seedTerminalRun({
      orgId,
      id: "run_late_commit",
      durationMs: 7_000,
      completedAt: new Date(NOW.getTime() + 10_000 - REPLAY_WINDOW_MS + 60_000),
    });
    const result = await settleTerminalRuns();

    expect(result.settled).toBe(1);
    expect(await secondsUsed()).toBe(12);
  });

  it("does not look further back than the replay window", async () => {
    seedTerminalRun({
      orgId,
      id: "run_head",
      durationMs: 5_000,
      completedAt: new Date(NOW.getTime() + 10_000),
    });
    await settleTerminalRuns();

    seedTerminalRun({
      orgId,
      id: "run_ancient",
      durationMs: 7_000,
      completedAt: new Date(NOW.getTime() + 10_000 - REPLAY_WINDOW_MS - 60_000),
    });
    const result = await settleTerminalRuns();

    expect(result.settled).toBe(0);
    expect(await secondsUsed()).toBe(5);
  });

  it("advances nothing when the platform read fails, and the next pass settles", async () => {
    seedTerminalRun({ orgId, durationMs: 30_000, completedAt: NOW });
    setMockRunsError();

    await expect(settleTerminalRuns()).rejects.toThrow("mock runs read failure");
    expect(await secondsUsed()).toBe(0);
    expect((await cursorRow()).completedAt.getTime()).toBe(0);

    const result = await settleTerminalRuns();
    expect(result.seconds).toBe(30);
    expect(await secondsUsed()).toBe(30);
  });

  it("refuses to guess a starting point when the watermark row is missing", async () => {
    await getBillingDb().delete(computeCursor);
    await expect(settleTerminalRuns()).rejects.toThrow("ee_compute_cursor is empty");
  });

  it("does not bill a run that finished before the watermark was seeded", async () => {
    seedTerminalRun({
      orgId,
      id: "run_before_feature",
      durationMs: 600_000,
      completedAt: new Date(NOW.getTime() - 3 * REPLAY_WINDOW_MS),
    });
    await seedComputeCursor({ completedAt: NOW });

    await settleTerminalRuns();

    expect(await secondsUsed()).toBe(0);
  });
});

describe("ensureComputeCursorSeeded", () => {
  beforeEach(async () => {
    await truncateBillingTables();
  });

  it("seeds the watermark one replay window ahead, so the first pass starts at now", async () => {
    const before = Date.now();
    await ensureComputeCursorSeeded();

    const row = await cursorRow();
    expect(row.completedAt.getTime()).toBeGreaterThanOrEqual(before + REPLAY_WINDOW_MS - 1000);
    expect(row.completedAt.getTime()).toBeLessThanOrEqual(Date.now() + REPLAY_WINDOW_MS + 1000);
    expect(row.runId).toBe("");
  });

  it("does not bill a run that finished minutes before the seed, replay window included", async () => {
    const before = Date.now();
    await ensureComputeCursorSeeded();
    // Finished 2 minutes before the module was enabled: inside a naive `now - window` reach.
    seedTerminalRun({
      orgId,
      id: "run_before_seed",
      durationMs: 600_000,
      completedAt: new Date(before - 2 * 60_000),
    });
    // And one that finishes after the seed, which the first pass must count.
    seedTerminalRun({
      orgId,
      id: "run_after_seed",
      durationMs: 30_000,
      completedAt: new Date(before + 1_000),
    });

    // The timer's pass: the one that re-reads the replay window.
    await settleTerminalRuns();

    expect(await secondsUsed()).toBe(30);
  });

  it("leaves an existing watermark alone, so a module that was off resumes where it stopped", async () => {
    const resumeAt = new Date("2026-01-01T00:00:00Z");
    await seedComputeCursor({ completedAt: resumeAt, runId: "run_last" });

    await ensureComputeCursorSeeded();
    await ensureComputeCursorSeeded();

    const row = await cursorRow();
    expect(row.completedAt.getTime()).toBe(resumeAt.getTime());
    expect(row.runId).toBe("run_last");
  });
});

describe("requestSettlement and the terminal event", () => {
  beforeEach(async () => {
    await truncateBillingTables();
    await seedComputeCursor();
  });

  it("settles in the background when a run reaches a terminal status", async () => {
    seedTerminalRun({ orgId, durationMs: 15_000, completedAt: NOW });

    await billingModule.events!.onRunStatusChange!({
      orgId,
      runId: "run_x",
      packageId: null,
      spaceId: "spc_x",
      status: "success",
    });
    await _awaitSettlementForTests();

    expect(await secondsUsed()).toBe(15);
  });

  it("ignores the started event, which carries no duration yet", async () => {
    seedTerminalRun({ orgId, durationMs: 15_000, completedAt: NOW });

    await billingModule.events!.onRunStatusChange!({
      orgId,
      runId: "run_x",
      packageId: null,
      spaceId: "spc_x",
      status: "started",
    });
    await _awaitSettlementForTests();

    expect(await secondsUsed()).toBe(0);
  });

  it("does not re-read the replay window on an event-triggered pass", async () => {
    seedTerminalRun({
      orgId,
      id: "run_head",
      durationMs: 5_000,
      completedAt: new Date(NOW.getTime() + 10_000),
    });
    await settleTerminalRuns();
    // A run that committed below the watermark, within the window.
    seedTerminalRun({
      orgId,
      id: "run_below",
      durationMs: 7_000,
      completedAt: new Date(NOW.getTime() + 10_000 - 60_000),
    });

    requestSettlement();
    await _awaitSettlementForTests();
    expect(await secondsUsed()).toBe(5);

    // The timer's pass is what recovers it.
    await settleTerminalRuns();
    expect(await secondsUsed()).toBe(12);
  });

  it("coalesces calls made during a pass and never throws on a failing read", async () => {
    seedTerminalRun({ orgId, durationMs: 15_000, completedAt: NOW });
    setMockRunsError();

    requestSettlement();
    requestSettlement();
    requestSettlement();
    await _awaitSettlementForTests();

    // The first pass failed and was swallowed; the queued rerun settled the run.
    expect(await secondsUsed()).toBe(15);
  });
});

describe("80 % compute warning", () => {
  const sent: { to: string; subject: string }[] = [];

  beforeEach(async () => {
    await truncateBillingTables();
    await seedComputeCursor();
    sent.length = 0;
    initBillingEmail({
      sendMail: async (to, subject) => {
        sent.push({ to, subject });
      },
      getRecipients: async () => ["billing@test.com"],
      getOrgName: async () => null,
    });
  });

  it("sends one email when a run carries the month across 80 % of the Free quota", async () => {
    await seedBillingAccount({ orgId, planId: "free" });
    // 47 000 s of 60 000 s (78 %), then a 2 000 s run lands on 81.7 %.
    await seedComputeUsage({ orgId, periodStart: THIS_MONTH, secondsUsed: 47_000 });
    seedTerminalRun({ orgId, durationMs: 2_000_000, completedAt: NOW });

    await settleTerminalRuns();
    await new Promise((r) => setTimeout(r, 100));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain("82");
  });

  it("does not repeat once past the threshold, and does not warn below it", async () => {
    await seedBillingAccount({ orgId, planId: "free" });
    seedTerminalRun({ orgId, durationMs: 10_000_000, completedAt: NOW }); // 16.7 %
    seedTerminalRun({
      orgId,
      durationMs: 40_000_000, // 83 %
      completedAt: new Date(NOW.getTime() + 1),
    });
    seedTerminalRun({
      orgId,
      durationMs: 1_000_000, // 85 %, already past
      completedAt: new Date(NOW.getTime() + 2),
    });

    await settleTerminalRuns({ batchSize: 1 });
    await new Promise((r) => setTimeout(r, 100));

    expect(sent).toHaveLength(1);
  });

  it("does not warn an org whose plan carries no compute quota", async () => {
    await seedBillingAccount({ orgId, planId: "starter" });
    seedTerminalRun({ orgId, durationMs: 100_000_000, completedAt: NOW });

    await settleTerminalRuns();
    await new Promise((r) => setTimeout(r, 100));

    expect(sent).toHaveLength(0);
  });

  it("does not warn about a month that is already over", async () => {
    await seedBillingAccount({ orgId, planId: "free" });
    const lastMonth = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 15));
    seedTerminalRun({ orgId, durationMs: 59_000_000, completedAt: lastMonth });

    await settleTerminalRuns({ replayWindowMs: 0 });
    await new Promise((r) => setTimeout(r, 100));

    expect(sent).toHaveLength(0);
  });
});

describe("org deletion", () => {
  it("drops the org's counters and claims", async () => {
    await truncateBillingTables();
    await seedComputeCursor();
    await seedBillingAccount({ orgId });
    seedTerminalRun({ orgId, durationMs: 30_000, completedAt: NOW });
    await settleTerminalRuns();

    await cancelSubscriptionAndCleanUp(orgId, null);

    expect(
      await getBillingDb().select().from(computeUsage).where(eq(computeUsage.orgId, orgId)),
    ).toEqual([]);
    expect(
      await getBillingDb().select().from(settledRuns).where(eq(settledRuns.orgId, orgId)),
    ).toEqual([]);
  });
});

/** Poll until `done()` holds, or fail after `ms`: a timer test must not guess a fixed delay. */
async function waitFor(done: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

describe("the catch-up timer", () => {
  beforeEach(async () => {
    await truncateBillingTables();
    await seedComputeCursor();
  });

  it("settles on its own, and stops when asked", async () => {
    seedTerminalRun({ orgId, durationMs: 12_000, completedAt: NOW });

    startComputeSweeper(5);
    await waitFor(async () => (await secondsUsed()) === 12);

    stopComputeSweeper();
    seedTerminalRun({
      orgId,
      durationMs: 8_000,
      completedAt: new Date(NOW.getTime() + 60_000),
    });
    await Bun.sleep(100);
    // Stopped: nothing settles the new run.
    expect(await secondsUsed()).toBe(12);
    await drainComputeSweeper();
  });

  it("purges the rows of deleted organizations once every sixty ticks", async () => {
    const goneOrg = "00000000-0000-4000-a000-000000000a09";
    seedOrgMembers(orgId, []);
    await seedComputeUsage({ orgId, periodStart: THIS_MONTH, secondsUsed: 30 });
    await seedComputeUsage({ orgId: goneOrg, periodStart: THIS_MONTH, secondsUsed: 99 });

    startComputeSweeper(1);
    await waitFor(
      async () => (await getBillingDb().select().from(computeUsage)).length === 1,
      20_000,
    );
    stopComputeSweeper();
    await drainComputeSweeper();

    const rows = await getBillingDb().select().from(computeUsage);
    expect(rows.map((r) => r.orgId)).toEqual([orgId]);
  });

  it("does not wait forever for a pass that never ends", async () => {
    setMockRunsHang();
    requestSettlement();

    const started = Date.now();
    await drainComputeSweeper(50);

    expect(Date.now() - started).toBeLessThan(2_000);
    releaseMockRunsHang();
    await _awaitSettlementForTests();
  });
});

describe("the warning is never allowed to fail a pass", () => {
  it("logs an alert that could not be evaluated, and carries on", async () => {
    const spy = spyOn(logger, "error").mockImplementation(() => {});
    try {
      emitComputeSignals([
        {
          orgId: "not-a-uuid",
          periodStart: THIS_MONTH,
          addedSeconds: 10,
          secondsUsed: 10,
        },
      ]);
      await Bun.sleep(100);
      expect(spy.mock.calls.some((c) => c[0] === "compute warning failed")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("logs, once, that the quota is reached when a run takes the month to 100 %", async () => {
    await truncateBillingTables();
    await seedComputeCursor();
    await seedBillingAccount({ orgId, planId: "free" });
    const spy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      seedTerminalRun({ orgId, durationMs: 61_000_000, completedAt: NOW });
      await settleTerminalRuns();
      await Bun.sleep(100);
      expect(
        spy.mock.calls.filter((c) => String(c[0]).startsWith("Compute quota reached")),
      ).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
