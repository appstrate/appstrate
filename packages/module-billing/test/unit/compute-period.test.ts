// SPDX-License-Identifier: Apache-2.0

/**
 * The pure rules of the compute-minutes quota: how a finished run turns into seconds (rounded
 * up, no minimum, remote runs free) and where a calendar month starts and ends.
 */
import { describe, expect, it } from "bun:test";
import {
  billableSeconds,
  periodEndOf,
  periodStartOf,
  quotaStanding,
} from "../../src/compute/period.ts";
import { aggregateByOrgAndMonth } from "../../src/compute/settlement.ts";

describe("billableSeconds", () => {
  it("counts a 40 second run as 40 seconds", () => {
    expect(billableSeconds({ runOrigin: "platform", durationMs: 40_000 })).toBe(40);
  });

  it("rounds up to the next second, with no minimum", () => {
    expect(billableSeconds({ runOrigin: "platform", durationMs: 400 })).toBe(1);
    expect(billableSeconds({ runOrigin: "platform", durationMs: 1 })).toBe(1);
    expect(billableSeconds({ runOrigin: "platform", durationMs: 1000 })).toBe(1);
    expect(billableSeconds({ runOrigin: "platform", durationMs: 1001 })).toBe(2);
    expect(billableSeconds({ runOrigin: "platform", durationMs: 40_001 })).toBe(41);
  });

  it("never rounds to the minute", () => {
    expect(billableSeconds({ runOrigin: "platform", durationMs: 61_000 })).toBe(61);
  });

  it("counts a remote run for nothing, however long", () => {
    expect(billableSeconds({ runOrigin: "remote", durationMs: 3_600_000 })).toBe(0);
  });

  it("counts a run with no usable duration for nothing", () => {
    expect(billableSeconds({ runOrigin: "platform", durationMs: null })).toBe(0);
    expect(billableSeconds({ runOrigin: "platform", durationMs: 0 })).toBe(0);
    expect(billableSeconds({ runOrigin: "platform", durationMs: -5 })).toBe(0);
    expect(billableSeconds({ runOrigin: "platform", durationMs: Number.NaN })).toBe(0);
  });
});

describe("calendar month (UTC)", () => {
  it("keys a moment to the first day of its UTC month", () => {
    expect(periodStartOf(new Date("2026-11-17T18:00:00Z"))).toBe("2026-11-01");
    expect(periodStartOf(new Date("2026-11-30T23:59:59.999Z"))).toBe("2026-11-01");
    expect(periodStartOf(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12-01");
  });

  it("uses UTC, not the host's zone", () => {
    // 23:30 on 30 Nov in New York (UTC-5) is already 1 Dec in UTC.
    expect(periodStartOf(new Date("2026-12-01T04:30:00Z"))).toBe("2026-12-01");
  });

  it("ends a month at the start of the next, across a year boundary", () => {
    expect(periodEndOf("2026-11-01").toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(periodEndOf("2026-12-01").toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("quotaStanding", () => {
  it("reads 100 % exactly when the quota is used up, never before", () => {
    expect(quotaStanding(0, 1000)).toEqual({ quotaSeconds: 60_000, percent: 0, exhausted: false });
    expect(quotaStanding(59_999, 1000)).toEqual({
      quotaSeconds: 60_000,
      percent: 99,
      exhausted: false,
    });
    expect(quotaStanding(60_000, 1000)).toEqual({
      quotaSeconds: 60_000,
      percent: 100,
      exhausted: true,
    });
  });

  it("caps the share at 100 when the soft cap let consumption overshoot", () => {
    expect(quotaStanding(90_000, 1000)).toMatchObject({ percent: 100, exhausted: true });
  });
});

describe("aggregateByOrgAndMonth", () => {
  it("adds one increment per org and month, ignoring runs worth nothing", () => {
    expect(
      aggregateByOrgAndMonth([
        { orgId: "b", periodStart: "2026-11-01", seconds: 10 },
        { orgId: "b", periodStart: "2026-11-01", seconds: 5 },
        { orgId: "b", periodStart: "2026-11-01", seconds: 0 },
        { orgId: "a", periodStart: "2026-11-01", seconds: 1 },
      ]),
    ).toEqual([
      { orgId: "a", periodStart: "2026-11-01", seconds: 1 },
      { orgId: "b", periodStart: "2026-11-01", seconds: 15 },
    ]);
  });

  it("orders increments by org then month whatever the order of the runs, so two replicas lock counter rows in the same order", () => {
    const forward = [
      { orgId: "x", periodStart: "2026-11-01", seconds: 1 },
      { orgId: "y", periodStart: "2026-11-01", seconds: 1 },
      { orgId: "x", periodStart: "2026-10-01", seconds: 1 },
    ];
    const reversed = [...forward].reverse();
    const keys = (rows: typeof forward) =>
      aggregateByOrgAndMonth(rows).map((r) => `${r.orgId}|${r.periodStart}`);
    expect(keys(forward)).toEqual(["x|2026-10-01", "x|2026-11-01", "y|2026-11-01"]);
    expect(keys(reversed)).toEqual(keys(forward));
  });
});
