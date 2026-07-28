// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the mid-run deadline nudges (`scheduleDeadlineNudges`).
 *
 * Production shape being defended: the run budget is stated once in the turn-1
 * system prompt and the agent has no clock afterwards, so it explores at a
 * comfortable pace and the watchdog kills it at 100% with its deliverable never
 * emitted. Two steering messages re-state the remaining budget while the
 * session is still alive and can act on it.
 *
 * Timers and clock are injected — nothing here waits on real time.
 */

import { describe, it, expect } from "bun:test";
import {
  DEADLINE_NUDGE_EVENT,
  DEADLINE_NUDGE_FRACTIONS,
  scheduleDeadlineNudges,
} from "../src/deadline-nudges.ts";
import type { RunEvent } from "@appstrate/afps-runtime/types";

const RUN_ID = "run_deadline_test";
/** 10 minutes — checkpoints land on round numbers (450s / 540s, 150s / 60s left). */
const BUDGET_SECONDS = 600;

interface FakeTimer {
  delayMs: number;
  fire: () => void;
  cleared: boolean;
}

/** Deterministic stand-in for `setTimeout`/`clearTimeout`, in schedule order. */
function createFakeTimers(): {
  timers: FakeTimer[];
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  clearCalls: number[];
} {
  const timers: FakeTimer[] = [];
  const clearCalls: number[] = [];
  const setTimer = ((fn: () => void, delayMs?: number) => {
    timers.push({ delayMs: delayMs ?? 0, fire: fn, cleared: false });
    return timers.length - 1;
  }) as unknown as typeof setTimeout;
  const clearTimer = ((handle: number) => {
    clearCalls.push(handle);
    const timer = timers[handle];
    if (timer) timer.cleared = true;
  }) as unknown as typeof clearTimeout;
  return { timers, setTimer, clearTimer, clearCalls };
}

interface Harness {
  steers: string[];
  events: RunEvent[];
  timers: FakeTimer[];
  clearCalls: number[];
  cancel: () => void;
}

function arm(
  overrides: {
    timeoutSeconds?: number;
    steer?: (text: string) => Promise<void>;
    emit?: (event: RunEvent) => void | Promise<void>;
  } = {},
): Harness {
  const { timers, setTimer, clearTimer, clearCalls } = createFakeTimers();
  const steers: string[] = [];
  const events: RunEvent[] = [];
  const cancel = scheduleDeadlineNudges({
    timeoutSeconds: overrides.timeoutSeconds ?? BUDGET_SECONDS,
    steer:
      overrides.steer ??
      (async (text: string) => {
        steers.push(text);
      }),
    emit:
      overrides.emit ??
      ((event: RunEvent) => {
        events.push(event);
      }),
    runId: RUN_ID,
    setTimer,
    clearTimer,
    now: () => 1234,
  });
  return { steers, events, timers, clearCalls, cancel };
}

describe("scheduleDeadlineNudges — checkpoints", () => {
  it("uses exactly the 75% and 90% checkpoints", () => {
    expect([...DEADLINE_NUDGE_FRACTIONS]).toEqual([0.75, 0.9]);
  });

  it("arms one timer per checkpoint, at that fraction of the budget", () => {
    const h = arm();
    expect(h.timers.map((t) => t.delayMs)).toEqual([450_000, 540_000]);
  });

  it("steers with the seconds actually left at each checkpoint", async () => {
    const h = arm();
    h.timers[0]!.fire();
    h.timers[1]!.fire();
    await Promise.resolve();

    expect(h.steers).toHaveLength(2);
    expect(h.steers[0]).toContain("150 seconds remain");
    expect(h.steers[0]).toContain("600-second budget");
    expect(h.steers[1]).toContain("60 seconds remain");
    expect(h.steers[1]).toContain("600-second budget");
  });

  it("escalates from re-plan (75%) to deliver-now (90%)", () => {
    const h = arm();
    h.timers[0]!.fire();
    h.timers[1]!.fire();

    expect(h.steers[0]).toContain("Re-plan");
    expect(h.steers[1]).toContain("Stop starting new work");
    expect(h.steers[1]).toContain("deliver your result");
  });

  it("names no tool — usage prose belongs to each tool's MCP description (#368)", () => {
    const h = arm();
    h.timers[0]!.fire();
    h.timers[1]!.fire();

    for (const text of h.steers) {
      expect(text).not.toMatch(/output|publish_document|bash|report|note\b/i);
    }
  });

  it("emits an info `deadline_nudge` breadcrumb alongside each steer", () => {
    const h = arm();
    h.timers[0]!.fire();
    h.timers[1]!.fire();

    expect(h.events).toHaveLength(2);
    expect(h.events[0]).toMatchObject({
      type: "appstrate.progress",
      runId: RUN_ID,
      level: "info",
      timestamp: 1234,
      data: { event: DEADLINE_NUDGE_EVENT, remainingSeconds: 150, fraction: 0.75 },
    });
    expect(h.events[1]).toMatchObject({
      data: { event: DEADLINE_NUDGE_EVENT, remainingSeconds: 60, fraction: 0.9 },
    });
  });
});

describe("scheduleDeadlineNudges — no budget", () => {
  // `executeSession` passes `context.timeoutSeconds ?? 0`, so an agent with no
  // declared timeout reaches this function as 0 — same gate as `run()`'s watchdog.
  for (const timeoutSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`schedules nothing for timeoutSeconds=${String(timeoutSeconds)}`, () => {
      const h = arm({ timeoutSeconds });
      expect(h.timers).toHaveLength(0);
      h.cancel(); // cancelling a no-op schedule is itself a no-op
      expect(h.clearCalls).toHaveLength(0);
    });
  }
});

describe("scheduleDeadlineNudges — cancellation", () => {
  it("clears pending timers", () => {
    const h = arm();
    h.cancel();
    expect(h.timers.every((t) => t.cleared)).toBe(true);
  });

  it("makes a timer that fires anyway a no-op", () => {
    // Defends the real risk: `clearTimeout` cannot un-schedule a callback the
    // event loop has already picked up, and the prompt may settle in that
    // window. A nudge must never reach a session that is done.
    const h = arm();
    h.timers[0]!.fire();
    h.cancel();
    h.timers[1]!.fire();

    expect(h.steers).toHaveLength(1);
    expect(h.events).toHaveLength(1);
  });
});

describe("scheduleDeadlineNudges — failure isolation", () => {
  it("swallows a rejecting steer", async () => {
    const h = arm({ steer: () => Promise.reject(new Error("session is gone")) });
    expect(() => h.timers[0]!.fire()).not.toThrow();
    await Promise.resolve();
  });

  it("swallows a steer that throws synchronously", () => {
    const h = arm({
      steer: () => {
        throw new Error("session is gone");
      },
    });
    expect(() => h.timers[0]!.fire()).not.toThrow();
  });

  it("still steers when the breadcrumb emit throws", () => {
    const steers: string[] = [];
    const h = arm({
      emit: () => {
        throw new Error("sink closed");
      },
      steer: async (text) => {
        steers.push(text);
      },
    });
    h.timers[0]!.fire();

    expect(steers).toHaveLength(1);
  });

  it("still steers when the breadcrumb emit rejects", async () => {
    const steers: string[] = [];
    const h = arm({
      emit: () => Promise.reject(new Error("sink closed")),
      steer: async (text) => {
        steers.push(text);
      },
    });
    h.timers[0]!.fire();
    await Promise.resolve();

    expect(steers).toHaveLength(1);
  });
});
