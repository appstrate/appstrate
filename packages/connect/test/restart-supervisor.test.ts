// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the restart-with-backoff supervisor (proposal §5.4.2).
 *
 * Every test injects `sleep` so backoff delays are virtualised — no
 * real time elapses. The injected sleep is a controllable promise
 * factory: tests await `process.done` after triggering enough exits
 * to exhaust the schedule.
 */

import { describe, it, expect } from "bun:test";
import {
  superviseProcess,
  type ChildExit,
  type ChildHandle,
  type SupervisorEvent,
} from "../src/restart-supervisor.ts";

/** Build a controllable child handle whose exit is resolved on-demand. */
function makeControllableChild() {
  let resolveExit!: (exit: ChildExit) => void;
  const exited = new Promise<ChildExit>((res) => {
    resolveExit = res;
  });
  let killed: string | undefined;
  const handle: ChildHandle = {
    exited,
    kill(reason) {
      killed = reason;
    },
  };
  return {
    handle,
    crash: (code = 1) => resolveExit({ kind: "normal-exit", code }),
    signal: (sig: string) => resolveExit({ kind: "signal", signal: sig }),
    get killed() {
      return killed;
    },
  };
}

/** Sleep mock that records every call so tests can assert the backoff schedule. */
function makeRecordingSleep() {
  const calls: number[] = [];
  return {
    calls,
    sleep: (ms: number) => {
      calls.push(ms);
      return Promise.resolve();
    },
  };
}

describe("superviseProcess — happy path", () => {
  it("declares max-restarts after the configured schedule is exhausted", async () => {
    const sleep = makeRecordingSleep();
    const events: SupervisorEvent[] = [];
    const children: Array<ReturnType<typeof makeControllableChild>> = [];

    let spawnIdx = 0;
    const proc = superviseProcess(
      async () => {
        const child = makeControllableChild();
        children.push(child);
        spawnIdx += 1;
        return child.handle;
      },
      {
        schedule: [10, 20, 30],
        sleep: sleep.sleep,
        onEvent: (e) => events.push(e),
      },
    );

    // Settle the microtask queue so the first spawn happens.
    await Promise.resolve();
    await Promise.resolve();
    children[0]!.crash(1);

    // Each subsequent crash triggers the next backoff + respawn.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(spawnIdx).toBe(2);
    children[1]!.crash(1);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(spawnIdx).toBe(3);
    children[2]!.crash(1);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(spawnIdx).toBe(4);
    children[3]!.crash(1);

    const outcome = await proc.done;
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("max-restarts");
    // schedule.length + 1 (initial spawn) total attempts.
    expect(outcome.attempts).toBe(4);
    expect(sleep.calls).toEqual([10, 20, 30]);
    expect(events.find((e) => e.type === "max-attempts-reached")).toBeDefined();
  });

  it("counts a spawn failure (factory rejection) as an attempt and restarts", async () => {
    const sleep = makeRecordingSleep();
    const events: SupervisorEvent[] = [];
    let calls = 0;

    const proc = superviseProcess(
      async () => {
        calls += 1;
        throw new Error(`boom-${calls}`);
      },
      { schedule: [5, 10], sleep: sleep.sleep, onEvent: (e) => events.push(e) },
    );

    const outcome = await proc.done;
    expect(outcome.reason).toBe("max-restarts");
    expect(outcome.attempts).toBe(3);
    expect(events.filter((e) => e.type === "spawn-failure").length).toBe(3);
    expect(sleep.calls).toEqual([5, 10]);
  });
});

describe("superviseProcess — stop()", () => {
  it("stop() during a running attempt kills the child and resolves with reason=stopped", async () => {
    const sleep = makeRecordingSleep();
    const child = makeControllableChild();

    const proc = superviseProcess(async () => child.handle, {
      schedule: [10, 10, 10],
      sleep: sleep.sleep,
    });

    await Promise.resolve();
    await Promise.resolve();

    const stopPromise = proc.stop();
    // After kill, the child's exited promise still needs to resolve;
    // emulate the child responding to SIGTERM.
    child.signal("SIGTERM");
    await stopPromise;

    const outcome = await proc.done;
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("stopped");
    expect(child.killed).toBe("supervisor-stop");
    // No backoff sleep — supervisor was stopped before any restart.
    expect(sleep.calls).toEqual([]);
  });

  it("stop() called twice is idempotent", async () => {
    const child = makeControllableChild();
    const proc = superviseProcess(async () => child.handle, {
      schedule: [10],
      sleep: () => Promise.resolve(),
    });
    await Promise.resolve();
    const a = proc.stop();
    const b = proc.stop();
    child.signal("SIGTERM");
    await Promise.all([a, b]);
    const outcome = await proc.done;
    expect(outcome.reason).toBe("stopped");
  });

  it("stop() during the backoff wait skips the next spawn", async () => {
    // Build a sleep that resolves only when the test releases it.
    let releaseSleep!: () => void;
    const sleepPromise = new Promise<void>((res) => {
      releaseSleep = res;
    });
    const sleep = (_ms: number) => sleepPromise;

    let spawnCount = 0;
    const children: Array<ReturnType<typeof makeControllableChild>> = [];
    const proc = superviseProcess(
      async () => {
        spawnCount += 1;
        const c = makeControllableChild();
        children.push(c);
        return c.handle;
      },
      { schedule: [9999], sleep },
    );

    await Promise.resolve();
    await Promise.resolve();
    children[0]!.crash(1);
    // Supervisor now awaits the (frozen) sleep before respawn.
    await Promise.resolve();
    await Promise.resolve();

    const stopPromise = proc.stop();
    releaseSleep();
    await stopPromise;
    const outcome = await proc.done;
    expect(outcome.reason).toBe("stopped");
    // Only the first spawn happened — the second never fired.
    expect(spawnCount).toBe(1);
  });
});

describe("superviseProcess — events", () => {
  it("emits spawn-success / child-exited / restart-scheduled with attempt + delay", async () => {
    const events: SupervisorEvent[] = [];
    const children: Array<ReturnType<typeof makeControllableChild>> = [];
    const proc = superviseProcess(
      async () => {
        const c = makeControllableChild();
        children.push(c);
        return c.handle;
      },
      {
        schedule: [7],
        sleep: () => Promise.resolve(),
        onEvent: (e) => events.push(e),
        now: () => 42,
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    children[0]!.crash(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    children[1]!.crash(1);
    await proc.done;

    const types = events.map((e) => e.type);
    expect(types).toContain("spawn-success");
    expect(types).toContain("child-exited");
    expect(types).toContain("restart-scheduled");
    const scheduled = events.find((e) => e.type === "restart-scheduled")!;
    expect(scheduled.delayMs).toBe(7);
    expect(scheduled.attempt).toBe(2);
    expect(events.every((e) => e.at === 42)).toBe(true);
  });
});

describe("superviseProcess — input validation", () => {
  it("rejects an empty schedule (1 attempt + 0 restarts is operator error)", () => {
    expect(() =>
      superviseProcess(() => Promise.reject(new Error("noop")), { schedule: [] }),
    ).toThrow(/at least one entry/);
  });
});

describe("superviseProcess — attemptCount", () => {
  it("starts at 0 before the first spawn and increments per attempt", async () => {
    const children: Array<ReturnType<typeof makeControllableChild>> = [];
    const proc = superviseProcess(
      async () => {
        const c = makeControllableChild();
        children.push(c);
        return c.handle;
      },
      { schedule: [1], sleep: () => Promise.resolve() },
    );
    // Tick once for the first spawn.
    await Promise.resolve();
    await Promise.resolve();
    expect(proc.attemptCount()).toBe(1);
    children[0]!.crash(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(proc.attemptCount()).toBe(2);
    children[1]!.crash(1);
    await proc.done;
    expect(proc.attemptCount()).toBe(2);
  });
});
