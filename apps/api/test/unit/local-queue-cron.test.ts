// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for LocalQueue cron scheduling.
 *
 * Asserts OBSERVABLE behavior: given a scheduler whose next run falls inside
 * the current poll window, does `evaluateCron` actually enqueue + run the job?
 * The evaluator delegates to `computeNextRun` (cron-parser), so the cases here
 * cover the same expression shapes the old hand-rolled parser did — exact
 * minute/hour, day-of-month, month, day-of-week (incl. the `7`→Sunday alias),
 * timezone offsets — PLUS the cases that parser silently dropped: 1-token
 * presets (`@daily`) and named aliases (`MON`).
 */

import { describe, it, expect } from "bun:test";
import { LocalQueue } from "../../src/infra/queue/local-queue.ts";
import type { QueueJob } from "../../src/infra/queue/interface.ts";

/**
 * Drive one cron evaluation at a fixed wall-clock `now` and report whether the
 * pattern fired. `evaluateCron` reads `Date.now()` and bases its lookup on the
 * preceding poll window, so we pin `Date.now` to `now` for the call.
 */
async function fires(pattern: string, now: Date, tz?: string): Promise<boolean> {
  const q = new LocalQueue<{ v: string }>("test-cron") as any;
  const processed: string[] = [];
  q.process(async (job: QueueJob<{ v: string }>) => {
    processed.push(job.data.v);
  });
  await q.upsertScheduler(
    "s",
    { pattern, ...(tz ? { tz } : {}) },
    { name: "cron-job", data: { v: "fired" } },
  );

  const realNow = Date.now;
  Date.now = () => now.getTime();
  try {
    q.evaluateCron();
  } finally {
    Date.now = realNow;
  }

  await new Promise((r) => setTimeout(r, 200));
  await q.shutdown();
  return processed.includes("fired");
}

/**
 * An instant whose preceding 30s poll window [now-30s, now] is guaranteed to
 * contain a minute boundary — so a `* * * * *` schedule deterministically
 * fires when `evaluateCron` runs at this clock. (`Date.now` at an arbitrary
 * wall-clock second can land a window between two minute boundaries, missing a
 * once-a-minute schedule — fine in production where polls repeat, flaky in a
 * single-shot unit test.) 10s past a minute boundary keeps the boundary inside
 * the window.
 */
const FIRING_NOW = new Date("2026-01-15T10:30:10Z");

/** Run `fn` with `Date.now` pinned to `at`, restoring it afterward. */
function withPinnedNow<R>(at: Date, fn: () => R): R {
  const realNow = Date.now;
  Date.now = () => at.getTime();
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
}

// ---------------------------------------------------------------------------
// Firing behavior — does the scheduled job actually run in its window?
// ---------------------------------------------------------------------------

describe("LocalQueue cron firing", () => {
  // The poll window is [now-30s, now]. A "30 10 * * *" run at 10:30:00 fires
  // when the poll lands anywhere in 10:30:00–10:30:30.
  it("fires at exact minute/hour inside the window", async () => {
    expect(await fires("30 10 * * *", new Date("2026-01-15T10:30:10Z"))).toBe(true);
  });

  it("does not fire when the window is outside the schedule", async () => {
    expect(await fires("31 10 * * *", new Date("2026-01-15T10:30:10Z"))).toBe(false);
  });

  it("fires every minute (* * * * *)", async () => {
    expect(await fires("* * * * *", new Date("2026-01-15T10:30:10Z"))).toBe(true);
  });

  it("fires on a specific day of month", async () => {
    expect(await fires("30 10 15 * *", new Date("2026-01-15T10:30:10Z"))).toBe(true);
    expect(await fires("30 10 16 * *", new Date("2026-01-15T10:30:10Z"))).toBe(false);
  });

  it("fires on a specific month", async () => {
    expect(await fires("30 10 15 3 *", new Date("2026-03-15T10:30:10Z"))).toBe(true);
    expect(await fires("30 10 15 4 *", new Date("2026-03-15T10:30:10Z"))).toBe(false);
  });

  it("fires on day of week 0 (Sunday)", async () => {
    // 2026-01-18 is a Sunday
    expect(await fires("30 10 * * 0", new Date("2026-01-18T10:30:10Z"))).toBe(true);
    expect(await fires("30 10 * * 1", new Date("2026-01-18T10:30:10Z"))).toBe(false);
  });

  it("fires on day of week 7 (Sunday alias)", async () => {
    expect(await fires("30 10 * * 7", new Date("2026-01-18T10:30:10Z"))).toBe(true);
  });

  it("respects timezone", async () => {
    // 2026-01-15 10:30 UTC = 11:30 CET (Europe/Paris, winter)
    expect(await fires("30 11 * * *", new Date("2026-01-15T10:30:10Z"), "Europe/Paris")).toBe(true);
    expect(await fires("30 10 * * *", new Date("2026-01-15T10:30:10Z"), "Europe/Paris")).toBe(
      false,
    );
  });

  // Regression: the old hand-rolled parser bailed on any expression with fewer
  // than 5 fields, so a 1-token preset NEVER fired even though `isValidCron`
  // accepted it. cron-parser handles presets, so it now fires correctly.
  it("fires on the @daily preset at midnight (regression — preset never fired before)", async () => {
    expect(await fires("@daily", new Date("2026-01-15T00:00:10Z"))).toBe(true);
    expect(await fires("@daily", new Date("2026-01-15T10:30:10Z"))).toBe(false);
  });

  // Regression: the old parser did `parseInt("MON")` → NaN → never matched.
  // cron-parser resolves named aliases. 2026-01-19 is a Monday.
  it("fires on a named day-of-week alias (regression — MON parsed to NaN before)", async () => {
    expect(await fires("0 0 * * MON", new Date("2026-01-19T00:00:10Z"))).toBe(true);
    expect(await fires("0 0 * * MON", new Date("2026-01-18T00:00:10Z"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scheduler integration (upsertScheduler + evaluateCron + removeScheduler)
// ---------------------------------------------------------------------------

describe("LocalQueue cron scheduler", () => {
  it("fires scheduled job via evaluateCron", async () => {
    const q = new LocalQueue<{ v: string }>("test-cron") as any;
    const processed: string[] = [];

    q.process(async (job: QueueJob<{ v: string }>) => {
      processed.push(job.data.v);
    });

    // Use * * * * * (every minute) — evaluateCron checks the current window
    await q.upsertScheduler(
      "s1",
      { pattern: "* * * * *" },
      { name: "cron-job", data: { v: "fired" } },
    );

    withPinnedNow(FIRING_NOW, () => q.evaluateCron());

    await new Promise((r) => setTimeout(r, 300));
    expect(processed).toContain("fired");
    await q.shutdown();
  });

  it("does not re-fire the same occurrence on a second poll within the window", async () => {
    const q = new LocalQueue<{ v: string }>("test-cron") as any;
    const processed: string[] = [];

    q.process(async (job: QueueJob<{ v: string }>) => {
      processed.push(job.data.v);
    });

    // A once-a-minute schedule polled twice in quick succession (both polls
    // share the same minute boundary) must enqueue the occurrence only once.
    await q.upsertScheduler(
      "s-once",
      { pattern: "* * * * *" },
      { name: "cron-job", data: { v: "x" } },
    );

    withPinnedNow(FIRING_NOW, () => {
      q.evaluateCron();
      q.evaluateCron();
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(processed).toEqual(["x"]);
    await q.shutdown();
  });

  it("removes scheduler via removeScheduler", async () => {
    const q = new LocalQueue<{ v: string }>("test-cron") as any;
    const processed: string[] = [];

    q.process(async (job: QueueJob<{ v: string }>) => {
      processed.push(job.data.v);
    });

    await q.upsertScheduler("s2", { pattern: "* * * * *" }, { name: "cron-job", data: { v: "x" } });
    await q.removeScheduler("s2");

    withPinnedNow(FIRING_NOW, () => q.evaluateCron());
    await new Promise((r) => setTimeout(r, 300));
    expect(processed).toEqual([]);
    await q.shutdown();
  });

  it("upserts scheduler (replaces existing)", async () => {
    const q = new LocalQueue<{ v: string }>("test-cron") as any;
    const processed: string[] = [];

    q.process(async (job: QueueJob<{ v: string }>) => {
      processed.push(job.data.v);
    });

    await q.upsertScheduler("s3", { pattern: "* * * * *" }, { name: "job", data: { v: "old" } });
    await q.upsertScheduler("s3", { pattern: "* * * * *" }, { name: "job", data: { v: "new" } });

    withPinnedNow(FIRING_NOW, () => q.evaluateCron());
    await new Promise((r) => setTimeout(r, 300));
    expect(processed).toEqual(["new"]);
    await q.shutdown();
  });
});
