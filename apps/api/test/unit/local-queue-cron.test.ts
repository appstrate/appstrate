// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for LocalQueue cron scheduling.
 *
 * Asserts OBSERVABLE behavior: given a scheduler whose next run falls inside
 * the poll window `(prevPoll, now]`, does `evaluateCron` actually enqueue + run
 * the job? The evaluator delegates to `computeNextRun` (cron-parser), so the
 * cases here cover the same expression shapes the old hand-rolled parser did —
 * exact minute/hour, day-of-month, month, day-of-week (incl. the `7`→Sunday
 * alias), timezone offsets — PLUS the cases that parser silently dropped:
 * 1-token presets (`@daily`) and named aliases (`MON`).
 *
 * The window floor is the PREVIOUS poll time (`lastCronPollAt`), which the
 * worker sets to the start time on `process()` and advances on each poll. In
 * these unit tests we pin `Date.now` and set `lastCronPollAt` directly to model
 * the preceding poll, rather than running the real interval timer.
 */

import { describe, it, expect } from "bun:test";
import { LocalQueue } from "../../src/infra/queue/local-queue.ts";
import type { QueueJob } from "../../src/infra/queue/interface.ts";

/** Default poll cadence used by the queue (ms) — the standard window width. */
const POLL_MS = 30_000;

/**
 * Wait until the queue has fully drained (no pending or active jobs) so
 * `processed` reflects the final outcome of a poll. Deterministic
 * replacement for fixed sleeps: `evaluateCron` enqueues synchronously and
 * `activeJobs` stays > 0 until each handler settles, so `count() === 0`
 * means every fired occurrence has been processed — including the
 * negative cases, where nothing was enqueued and this returns immediately.
 */
async function drained(q: { count(): Promise<number> }): Promise<void> {
  const deadline = Date.now() + 2_000;
  while ((await q.count()) > 0) {
    if (Date.now() > deadline) throw new Error("queue did not drain within 2s");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Drive one cron evaluation at a fixed wall-clock `now` and report how many
 * times the pattern fired. Models a poll whose window floor is `windowMs`
 * before `now` (default = the real 30s cadence).
 */
async function firesCount(
  pattern: string,
  now: Date,
  tz?: string,
  windowMs: number = POLL_MS,
): Promise<number> {
  const q = new LocalQueue<{ v: string }>("test-cron") as any;
  const processed: string[] = [];
  q.process(async (job: QueueJob<{ v: string }>) => {
    processed.push(job.data.v);
  });

  const realNow = Date.now;
  // Register at the window floor so `lastFiredAt` (anchored to registration)
  // never sits after the occurrences this poll should see.
  Date.now = () => now.getTime() - windowMs;
  try {
    await q.upsertScheduler(
      "s",
      { pattern, ...(tz ? { tz } : {}) },
      { name: "cron-job", data: { v: "fired" } },
    );
  } finally {
    Date.now = realNow;
  }

  // Model the previous poll at the window floor, then poll at `now`.
  q.lastCronPollAt = now.getTime() - windowMs;
  Date.now = () => now.getTime();
  try {
    q.evaluateCron();
  } finally {
    Date.now = realNow;
  }

  await drained(q);
  await q.shutdown();
  return processed.filter((v) => v === "fired").length;
}

/** Convenience: did the pattern fire at least once in its window? */
async function fires(pattern: string, now: Date, tz?: string): Promise<boolean> {
  return (await firesCount(pattern, now, tz)) > 0;
}

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

/** Run async `fn` with `Date.now` pinned to `at`, restoring it afterward. */
async function withPinnedNowAsync<R>(at: Date, fn: () => Promise<R>): Promise<R> {
  const realNow = Date.now;
  Date.now = () => at.getTime();
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

const FIRING_NOW = new Date("2026-01-15T10:30:10Z");
/** Models the previous poll one window before `FIRING_NOW`. */
const PREV_POLL = new Date(FIRING_NOW.getTime() - POLL_MS);
/** Register before the window so the registration anchor doesn't suppress it. */
const REGISTERED_AT = new Date(FIRING_NOW.getTime() - 60_000);

// ---------------------------------------------------------------------------
// Firing behavior — does the scheduled job actually run in its window?
// ---------------------------------------------------------------------------

describe("LocalQueue cron firing", () => {
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

  // Drift: a poll that arrives late (event-loop pressure, blocked drain) sees a
  // window wider than the cadence. Every occurrence inside it must fire — not
  // just the first. Here a 115s-late poll spans two minute boundaries.
  it("fires every occurrence in a drifted (wider-than-cadence) window", async () => {
    // prev poll 10:30:10, poll lands at 10:32:05 → window covers 10:31 + 10:32
    expect(
      await firesCount("* * * * *", new Date("2026-01-15T10:32:05Z"), undefined, 115_000),
    ).toBe(2);
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

    await withPinnedNowAsync(REGISTERED_AT, () =>
      q.upsertScheduler("s1", { pattern: "* * * * *" }, { name: "cron-job", data: { v: "fired" } }),
    );

    q.lastCronPollAt = PREV_POLL.getTime();
    withPinnedNow(FIRING_NOW, () => q.evaluateCron());

    await drained(q);
    expect(processed).toContain("fired");
    await q.shutdown();
  });

  it("does not re-fire the same occurrence on a second poll within the window", async () => {
    const q = new LocalQueue<{ v: string }>("test-cron") as any;
    const processed: string[] = [];

    q.process(async (job: QueueJob<{ v: string }>) => {
      processed.push(job.data.v);
    });

    await withPinnedNowAsync(REGISTERED_AT, () =>
      q.upsertScheduler("s-once", { pattern: "* * * * *" }, { name: "cron-job", data: { v: "x" } }),
    );

    q.lastCronPollAt = PREV_POLL.getTime();
    withPinnedNow(FIRING_NOW, () => {
      q.evaluateCron();
      q.evaluateCron();
    });

    await drained(q);
    expect(processed).toEqual(["x"]);
    await q.shutdown();
  });

  it("removes scheduler via removeScheduler", async () => {
    const q = new LocalQueue<{ v: string }>("test-cron") as any;
    const processed: string[] = [];

    q.process(async (job: QueueJob<{ v: string }>) => {
      processed.push(job.data.v);
    });

    await withPinnedNowAsync(REGISTERED_AT, () =>
      q.upsertScheduler("s2", { pattern: "* * * * *" }, { name: "cron-job", data: { v: "x" } }),
    );
    await q.removeScheduler("s2");

    q.lastCronPollAt = PREV_POLL.getTime();
    withPinnedNow(FIRING_NOW, () => q.evaluateCron());
    await drained(q);
    expect(processed).toEqual([]);
    await q.shutdown();
  });

  it("does not replay an occurrence from before registration on the first poll", async () => {
    const q = new LocalQueue<{ v: string }>("test-cron") as any;
    const processed: string[] = [];

    q.process(async (job: QueueJob<{ v: string }>) => {
      processed.push(job.data.v);
    });

    // Register at 10:30:05 — just AFTER the 10:30:00 occurrence of a
    // once-a-minute schedule. The first poll, 10s later, must NOT replay the
    // 10:30:00 occurrence that fell before the scheduler existed (boot-replay
    // regression). Models the worker anchoring lastCronPollAt at start.
    const registeredAt = new Date("2026-01-15T10:30:05Z");
    await withPinnedNowAsync(registeredAt, () =>
      q.upsertScheduler("s-boot", { pattern: "* * * * *" }, { name: "job", data: { v: "x" } }),
    );
    q.lastCronPollAt = registeredAt.getTime();

    withPinnedNow(new Date("2026-01-15T10:30:15Z"), () => q.evaluateCron());
    await drained(q);
    expect(processed).toEqual([]);

    // The next occurrence (10:31:00) DOES fire once its window arrives. The
    // floor has advanced to the first poll's time, no manual reset needed.
    withPinnedNow(new Date("2026-01-15T10:31:10Z"), () => q.evaluateCron());
    await drained(q);
    expect(processed).toEqual(["x"]);

    await q.shutdown();
  });

  it("upserts scheduler (replaces existing)", async () => {
    const q = new LocalQueue<{ v: string }>("test-cron") as any;
    const processed: string[] = [];

    q.process(async (job: QueueJob<{ v: string }>) => {
      processed.push(job.data.v);
    });

    await withPinnedNowAsync(REGISTERED_AT, () =>
      q.upsertScheduler("s3", { pattern: "* * * * *" }, { name: "job", data: { v: "old" } }),
    );
    await withPinnedNowAsync(REGISTERED_AT, () =>
      q.upsertScheduler("s3", { pattern: "* * * * *" }, { name: "job", data: { v: "new" } }),
    );

    q.lastCronPollAt = PREV_POLL.getTime();
    withPinnedNow(FIRING_NOW, () => q.evaluateCron());
    await drained(q);
    expect(processed).toEqual(["new"]);
    await q.shutdown();
  });

  it("caps catch-up burst and coalesces the backlog (no unbounded burst, no replay)", async () => {
    const q = new LocalQueue<{ v: string }>("test-cron") as any;
    const processed: string[] = [];

    q.process(async (job: QueueJob<{ v: string }>) => {
      processed.push(job.data.v);
    });

    // A long freeze: prev poll ~6.5 min ago. A once-a-minute schedule has 7
    // pending occurrences in (floor, now] — more than the per-poll cap (5).
    const floor = new Date(FIRING_NOW.getTime() - 400_000); // 10:23:30
    await withPinnedNowAsync(floor, () =>
      q.upsertScheduler("s-burst", { pattern: "* * * * *" }, { name: "job", data: { v: "x" } }),
    );
    q.lastCronPollAt = floor.getTime();

    withPinnedNow(FIRING_NOW, () => q.evaluateCron());
    await drained(q);
    // Capped at 5, not the 7 that fell in the window.
    expect(processed.length).toBe(5);

    // Backlog was coalesced (lastFiredAt advanced to now) — a second poll at
    // the same clock replays nothing.
    withPinnedNow(FIRING_NOW, () => q.evaluateCron());
    await drained(q);
    expect(processed.length).toBe(5);

    await q.shutdown();
  });
});
