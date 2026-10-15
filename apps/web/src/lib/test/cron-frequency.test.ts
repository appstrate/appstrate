// SPDX-License-Identifier: Apache-2.0

/**
 * The composer reads an expression into a shape and writes it back: every
 * shape must round-trip, and anything it cannot say must stay the author's
 * expression, untouched.
 */

import { describe, expect, it } from "bun:test";
import {
  HOUR_STEPS,
  MINUTE_STEPS,
  nextFires,
  parseCron,
  toCron,
  type Frequency,
} from "../cron-frequency.ts";

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

describe("every N minutes or hours", () => {
  it("offers only the steps that divide the hour or the day: the rhythm stays even", () => {
    for (const every of MINUTE_STEPS) expect(60 % every).toBe(0);
    for (const every of HOUR_STEPS) expect(24 % every).toBe(0);
  });

  it("keeps a step that restarts unevenly as the raw expression, never « every 45 minutes »", () => {
    // `*\/45` fires at :00 and :45 of every hour: 45 minutes, then 15.
    const fires = nextFires("*/45 * * * *", "UTC", 3, new Date("2026-10-08T12:01:00Z"));
    expect(fires?.map((d) => d.toISOString().slice(11, 16))).toEqual(["12:45", "13:00", "13:45"]);
    for (const cron of ["*/45 * * * *", "*/7 * * * *", "0 */5 * * *", "0 */7 * * *"]) {
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
