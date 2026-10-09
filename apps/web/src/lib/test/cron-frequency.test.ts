// SPDX-License-Identifier: Apache-2.0

/**
 * The composer reads an expression into a shape and writes it back: every
 * shape must round-trip, and anything it cannot say must stay the author's
 * expression, untouched.
 */

import { describe, expect, it } from "bun:test";
import { nextFires, parseCron, toCron, type Frequency } from "../cron-frequency.ts";

const at = (hour: number, minute = 0) => ({ hour, minute });

describe("parseCron", () => {
  it("reads every shape the composer writes", () => {
    const cases: Array<[string, Frequency]> = [
      ["* * * * *", { kind: "minutes", every: 1 }],
      ["*/15 * * * *", { kind: "minutes", every: 15 }],
      ["0 * * * *", { kind: "hours", every: 1, minute: 0 }],
      ["5 */2 * * *", { kind: "hours", every: 2, minute: 5 }],
      ["30 9 * * *", { kind: "daily", at: at(9, 30) }],
      ["0 9 * * 1,4", { kind: "weekly", days: [1, 4], at: at(9) }],
      ["0 18 15 * *", { kind: "monthly", day: 15, at: at(18) }],
    ];
    for (const [cron, frequency] of cases) {
      expect(parseCron(cron)).toEqual(frequency);
      expect(toCron(frequency)).toBe(cron);
    }
  });

  it("reads weekday ranges and Sunday as 7, and a full week as every day", () => {
    expect(parseCron("0 9 * * 1-5")).toEqual({ kind: "weekly", days: [1, 2, 3, 4, 5], at: at(9) });
    expect(parseCron("0 9 * * 7")).toEqual({ kind: "weekly", days: [0], at: at(9) });
    expect(parseCron("0 9 * * 0-6")).toEqual({ kind: "daily", at: at(9) });
  });

  it("keeps what it cannot say as the author's expression", () => {
    for (const cron of ["0 9 1 */3 *", "0 9-17 * * *", "0,30 9 * * *", "0 9 1 * 1", "bad"]) {
      expect(parseCron(cron)).toEqual({ kind: "custom", cron });
    }
  });
});

describe("nextFires", () => {
  it("answers in the schedule's time zone", () => {
    const from = new Date("2026-10-08T12:00:00Z");
    const fires = nextFires("0 9 * * *", "America/Toronto", 2, from);
    // 9:00 in Toronto (EDT, UTC-4) is 13:00 UTC.
    expect(fires?.map((d) => d.toISOString())).toEqual([
      "2026-10-08T13:00:00.000Z",
      "2026-10-09T13:00:00.000Z",
    ]);
  });

  it("is null for an expression the scheduler would refuse", () => {
    expect(nextFires("not cron", "UTC")).toBeNull();
  });
});
