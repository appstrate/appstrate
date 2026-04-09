// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for LocalQueue cron scheduling and matching logic.
 * Verifies cron expression parsing, timezone support, and dow=7 normalization.
 */

import { describe, it, expect } from "bun:test";
import { LocalQueue } from "../../src/infra/queue/local-queue.ts";
import type { QueueJob } from "../../src/infra/queue/interface.ts";

 
function createQueue(): any {
  return new LocalQueue<{ v: string }>("test-cron");
}

// ---------------------------------------------------------------------------
// matchField
// ---------------------------------------------------------------------------

describe("LocalQueue matchField", () => {
  const q = createQueue();

  it("matches wildcard *", () => {
    expect(q.matchField("*", 5, 0, 59)).toBe(true);
    expect(q.matchField("*", 0, 0, 59)).toBe(true);
  });

  it("matches exact value", () => {
    expect(q.matchField("5", 5, 0, 59)).toBe(true);
    expect(q.matchField("5", 6, 0, 59)).toBe(false);
  });

  it("matches comma list", () => {
    expect(q.matchField("1,5,10", 5, 0, 59)).toBe(true);
    expect(q.matchField("1,5,10", 3, 0, 59)).toBe(false);
  });

  it("matches range", () => {
    expect(q.matchField("5-10", 7, 0, 59)).toBe(true);
    expect(q.matchField("5-10", 5, 0, 59)).toBe(true);
    expect(q.matchField("5-10", 10, 0, 59)).toBe(true);
    expect(q.matchField("5-10", 11, 0, 59)).toBe(false);
  });

  it("matches step */N", () => {
    expect(q.matchField("*/5", 0, 0, 59)).toBe(true);
    expect(q.matchField("*/5", 5, 0, 59)).toBe(true);
    expect(q.matchField("*/5", 10, 0, 59)).toBe(true);
    expect(q.matchField("*/5", 3, 0, 59)).toBe(false);
  });

  it("matches range with step N-M/S", () => {
    expect(q.matchField("10-20/5", 10, 0, 59)).toBe(true);
    expect(q.matchField("10-20/5", 15, 0, 59)).toBe(true);
    expect(q.matchField("10-20/5", 12, 0, 59)).toBe(false);
  });

  it("normalizes dow=7 to 0 (Sunday)", () => {
    // 7 in the cron field should match value 0 (Sunday)
    expect(q.matchField("7", 0, 0, 6, true)).toBe(true);
    expect(q.matchField("7", 6, 0, 6, true)).toBe(false);
    // 0 should still match 0
    expect(q.matchField("0", 0, 0, 6, true)).toBe(true);
  });

  it("does not normalize dow=7 when isDow is false", () => {
    expect(q.matchField("7", 0, 0, 7, false)).toBe(false);
    expect(q.matchField("7", 7, 0, 7, false)).toBe(true);
  });

  it("handles dow=7 in comma list", () => {
    // "1,7" should match Monday (1) and Sunday (0)
    expect(q.matchField("1,7", 0, 0, 6, true)).toBe(true);
    expect(q.matchField("1,7", 1, 0, 6, true)).toBe(true);
    expect(q.matchField("1,7", 3, 0, 6, true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldFire
// ---------------------------------------------------------------------------

describe("LocalQueue shouldFire", () => {
  const q = createQueue();

  it("fires on * * * * * (every minute)", () => {
    const now = new Date("2026-01-15T10:30:00Z");
    expect(q.shouldFire("* * * * *", "UTC", now)).toBe(true);
  });

  it("fires at exact minute/hour", () => {
    const now = new Date("2026-01-15T10:30:00Z");
    expect(q.shouldFire("30 10 * * *", "UTC", now)).toBe(true);
    expect(q.shouldFire("31 10 * * *", "UTC", now)).toBe(false);
  });

  it("fires on specific day of month", () => {
    const now = new Date("2026-01-15T10:30:00Z");
    expect(q.shouldFire("30 10 15 * *", "UTC", now)).toBe(true);
    expect(q.shouldFire("30 10 16 * *", "UTC", now)).toBe(false);
  });

  it("fires on specific month", () => {
    const now = new Date("2026-03-15T10:30:00Z");
    expect(q.shouldFire("30 10 15 3 *", "UTC", now)).toBe(true);
    expect(q.shouldFire("30 10 15 4 *", "UTC", now)).toBe(false);
  });

  it("fires on day of week with 0 (Sunday)", () => {
    // 2026-01-18 is a Sunday
    const sunday = new Date("2026-01-18T10:30:00Z");
    expect(q.shouldFire("30 10 * * 0", "UTC", sunday)).toBe(true);
    expect(q.shouldFire("30 10 * * 1", "UTC", sunday)).toBe(false);
  });

  it("fires on day of week with 7 (Sunday alias)", () => {
    // 2026-01-18 is a Sunday — dow=7 should match
    const sunday = new Date("2026-01-18T10:30:00Z");
    expect(q.shouldFire("30 10 * * 7", "UTC", sunday)).toBe(true);
  });

  it("respects timezone", () => {
    // 2026-01-15 10:30 UTC = 11:30 CET (Europe/Paris, winter)
    const now = new Date("2026-01-15T10:30:00Z");
    expect(q.shouldFire("30 11 * * *", "Europe/Paris", now)).toBe(true);
    expect(q.shouldFire("30 10 * * *", "Europe/Paris", now)).toBe(false);
  });

  it("rejects invalid cron (too few fields)", () => {
    const now = new Date("2026-01-15T10:30:00Z");
    expect(q.shouldFire("30 10", "UTC", now)).toBe(false);
    expect(q.shouldFire("", "UTC", now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scheduler integration (upsertScheduler + evaluateCron)
// ---------------------------------------------------------------------------

describe("LocalQueue cron scheduler", () => {
  it("fires scheduled job via evaluateCron", async () => {
    const q = createQueue();
    const processed: string[] = [];

    q.process(async (job: QueueJob<{ v: string }>) => {
      processed.push(job.data.v);
    });

    // Use * * * * * (every minute) — evaluateCron checks current time
    await q.upsertScheduler(
      "s1",
      { pattern: "* * * * *" },
      { name: "cron-job", data: { v: "fired" } },
    );

    // Manually trigger evaluateCron
    q.evaluateCron();

    await new Promise((r) => setTimeout(r, 300));
    expect(processed).toContain("fired");
    await q.shutdown();
  });

  it("removes scheduler via removeScheduler", async () => {
    const q = createQueue();
    const processed: string[] = [];

    q.process(async (job: QueueJob<{ v: string }>) => {
      processed.push(job.data.v);
    });

    await q.upsertScheduler("s2", { pattern: "* * * * *" }, { name: "cron-job", data: { v: "x" } });
    await q.removeScheduler("s2");

    q.evaluateCron();
    await new Promise((r) => setTimeout(r, 300));
    expect(processed).toEqual([]);
    await q.shutdown();
  });

  it("upserts scheduler (replaces existing)", async () => {
    const q = createQueue();
    const processed: string[] = [];

    q.process(async (job: QueueJob<{ v: string }>) => {
      processed.push(job.data.v);
    });

    await q.upsertScheduler("s3", { pattern: "* * * * *" }, { name: "job", data: { v: "old" } });
    await q.upsertScheduler("s3", { pattern: "* * * * *" }, { name: "job", data: { v: "new" } });

    q.evaluateCron();
    await new Promise((r) => setTimeout(r, 300));
    expect(processed).toEqual(["new"]);
    await q.shutdown();
  });
});
