// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `LimiterRegistry` that replaced the hand-rolled
 * `Semaphore` from PR #429. Pin the contract:
 *
 *   - capacity enforcement under random interleaving (the #430 race
 *     reproducer — the old class let a sync `acquire()` slip past
 *     `maxConcurrent` because `release()` decremented before resolving
 *     the parked waiter; this test must fail against that code and
 *     pass against `p-queue`);
 *   - per-provider isolation — `default` covers everything that lacks
 *     an explicit override;
 *   - env-var parsing fails loud on malformed input;
 *   - `pause()` rejects new work with `DrainingError` and `onIdle()`
 *     completes when the backlog flushes;
 *   - queue-depth alert fires once per crossing, with injected
 *     time / threshold / dwell so tests don't depend on wall clock.
 */

import { describe, it, expect } from "bun:test";
import {
  DEFAULT_CONCURRENCY_KEY,
  DEFAULT_PROVIDER_CALL_CONCURRENCY,
  DrainingError,
  LimiterRegistry,
  parseConcurrencyConfig,
} from "../limiter.ts";

describe("parseConcurrencyConfig", () => {
  it("returns the platform default when env var is unset", () => {
    const cfg = parseConcurrencyConfig(undefined);
    expect(cfg.default).toBe(DEFAULT_PROVIDER_CALL_CONCURRENCY);
    expect(cfg.perProvider.size).toBe(0);
  });

  it("returns the platform default when env var is empty", () => {
    const cfg = parseConcurrencyConfig("");
    expect(cfg.default).toBe(DEFAULT_PROVIDER_CALL_CONCURRENCY);
  });

  it("parses a plain positive integer as the default cap", () => {
    const cfg = parseConcurrencyConfig("12");
    expect(cfg.default).toBe(12);
    expect(cfg.perProvider.size).toBe(0);
  });

  it("parses a JSON object with default + per-provider overrides", () => {
    const cfg = parseConcurrencyConfig('{"default":3,"@appstrate/gmail":8,"@appstrate/clickup":2}');
    expect(cfg.default).toBe(3);
    expect(cfg.perProvider.get("@appstrate/gmail")).toBe(8);
    expect(cfg.perProvider.get("@appstrate/clickup")).toBe(2);
    expect(cfg.perProvider.has(DEFAULT_CONCURRENCY_KEY)).toBe(false);
  });

  it("falls back to the platform default when JSON omits `default`", () => {
    const cfg = parseConcurrencyConfig('{"@appstrate/gmail":8}');
    expect(cfg.default).toBe(DEFAULT_PROVIDER_CALL_CONCURRENCY);
    expect(cfg.perProvider.get("@appstrate/gmail")).toBe(8);
  });

  it("rejects malformed JSON loudly", () => {
    expect(() => parseConcurrencyConfig("{not json")).toThrow(
      /SIDECAR_PROVIDER_CALL_CONCURRENCY: invalid JSON/,
    );
  });

  it("rejects non-object JSON values when the input opens with `{`", () => {
    // `[…]` and `null` don't start with `{`, so the parser routes them
    // through the int-or-die path; pin both behaviours explicitly.
    expect(() => parseConcurrencyConfig("[1,2,3]")).toThrow(
      /must be a positive integer or a JSON object/,
    );
    expect(() => parseConcurrencyConfig("null")).toThrow(
      /must be a positive integer or a JSON object/,
    );
    // A JSON object whose contents are nonsensical surfaces the
    // "must be an object" path only for the recognised opener.
    expect(() => parseConcurrencyConfig('{"default":"three"}')).toThrow(
      /must be a positive integer/,
    );
  });

  it("rejects non-positive-integer values in JSON", () => {
    for (const bad of ['{"default":0}', '{"default":-1}', '{"default":1.5}', '{"default":"3"}']) {
      expect(() => parseConcurrencyConfig(bad)).toThrow(/must be a positive integer/);
    }
  });

  it("rejects malformed plain values loudly", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "NaN"]) {
      expect(() => parseConcurrencyConfig(bad)).toThrow(
        /must be a positive integer or a JSON object/,
      );
    }
  });
});

describe("LimiterRegistry — capacity", () => {
  /**
   * Helper: drain all pending gates with microtask yields between
   * releases. p-queue dequeues on its own microtask after each
   * release; releasing all gates synchronously starves the next
   * tasks because their inner `gate` push hasn't landed yet.
   */
  async function drainGates(gates: Array<() => void>): Promise<void> {
    while (gates.length > 0) {
      gates.shift()!();
      for (let i = 0; i < 50; i++) await Promise.resolve();
    }
  }

  it("admits up to `default` concurrent runs per provider", async () => {
    const reg = new LimiterRegistry({ default: 3, perProvider: new Map() });
    let active = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const work = () =>
      reg.run("p", async () => {
        active++;
        if (active > peak) peak = active;
        await new Promise<void>((resolve) => gates.push(resolve));
        active--;
        return "ok";
      });
    const inflight = [work(), work(), work(), work(), work()];
    // Yield enough to let the first batch reach the gate.
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(active).toBe(3);
    expect(peak).toBe(3);
    expect(gates.length).toBe(3);
    await drainGates(gates);
    await Promise.all(inflight);
    expect(peak).toBe(3);
  });

  it("applies per-providerId overrides; default covers the rest", async () => {
    const reg = new LimiterRegistry({
      default: 1,
      perProvider: new Map([["fast", 4]]),
    });
    const gates: Array<() => void> = [];
    let fastActive = 0;
    let fastPeak = 0;
    let slowActive = 0;
    let slowPeak = 0;
    const fast = () =>
      reg.run("fast", async () => {
        fastActive++;
        if (fastActive > fastPeak) fastPeak = fastActive;
        await new Promise<void>((r) => gates.push(r));
        fastActive--;
      });
    const slow = () =>
      reg.run("slow", async () => {
        slowActive++;
        if (slowActive > slowPeak) slowPeak = slowActive;
        await new Promise<void>((r) => gates.push(r));
        slowActive--;
      });
    const inflight = [fast(), fast(), fast(), fast(), fast(), slow(), slow(), slow()];
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(fastPeak).toBe(4);
    expect(slowPeak).toBe(1);
    await drainGates(gates);
    await Promise.all(inflight);
    expect(fastPeak).toBe(4);
    expect(slowPeak).toBe(1);
  });

  /**
   * Cap-correctness under heavy concurrent bursts (#430).
   *
   * The bug in PR #429's hand-rolled `Semaphore`:
   *   1. r1, r2 active; p3 parked, `active === 2`.
   *   2. `r1()` releases: `active--` runs synchronously (`active === 1`),
   *      and the waiter resume is queued as a microtask.
   *   3. Before the microtask runs, a synchronous `acquire()` lands
   *      from another caller. It observes `active === 1 < maxConcurrent`
   *      and grabs a permit immediately, setting `active === 2`.
   *   4. The microtask fires, the parked waiter resolves, `active++`
   *      runs → `active === 3`, exceeding the cap.
   *
   * That bug is only directly reachable via the legacy raw
   * `acquire()`/`release()` API. The new API (`run(providerId, fn)`)
   * doesn't expose those primitives — releases are wired through
   * `p-queue`'s internal permit-transfer, which is race-free by
   * construction. This test pins the contract the caller cares about:
   * across many random release/arrival interleavings the active count
   * never exceeds `maxConcurrent`.
   *
   * The MCP-level race test in `mcp.test.ts` exercises the same
   * invariant end-to-end (50 simultaneous `tools/call` invocations,
   * peak ≤ cap), closing the loop on the issue.
   */
  it("never exceeds maxConcurrent across 200 jittered runs (#430 regression)", async () => {
    const reg = new LimiterRegistry({ default: 2, perProvider: new Map() });
    let active = 0;
    let peak = 0;
    const N = 200;
    let seed = 0x9e3779b9;
    const rand = () => {
      seed = (seed * 16807) % 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const work = () =>
      reg.run("race", async () => {
        active++;
        if (active > peak) peak = active;
        const yields = Math.floor(rand() * 6);
        for (let i = 0; i < yields; i++) await Promise.resolve();
        active--;
      });
    // Fire half up-front (forces parking), then drip the rest in
    // every few microtask ticks so releases land in the middle of
    // fresh arrivals.
    const all: Promise<unknown>[] = [];
    for (let i = 0; i < N / 2; i++) all.push(work());
    for (let i = 0; i < N / 2; i++) {
      for (let k = 0; k < Math.floor(rand() * 4); k++) await Promise.resolve();
      all.push(work());
    }
    await Promise.all(all);
    expect(active).toBe(0);
    expect(peak).toBeLessThanOrEqual(2);
    // Sanity: the limiter actually parked, otherwise the test is a no-op.
    expect(peak).toBe(2);
  });
});

describe("LimiterRegistry — drain", () => {
  it("rejects new runs with DrainingError after pause()", async () => {
    const reg = new LimiterRegistry({ default: 2, perProvider: new Map() });
    reg.pause();
    expect(reg.isDraining()).toBe(true);
    await expect(reg.run("p", async () => "ok")).rejects.toBeInstanceOf(DrainingError);
  });

  it("lets already-queued work finish; onIdle resolves true within the timeout", async () => {
    const reg = new LimiterRegistry({ default: 1, perProvider: new Map() });
    let gate: (() => void) | null = null;
    const inflight = reg.run("p", async () => {
      await new Promise<void>((resolve) => {
        gate = resolve;
      });
      return "done";
    });
    // Yield so the work picks up its permit before we pause.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    reg.pause();
    // New calls reject immediately.
    await expect(reg.run("p", async () => "ok")).rejects.toBeInstanceOf(DrainingError);
    // Existing call completes normally.
    gate!();
    expect(await inflight).toBe("done");
    expect(await reg.onIdle(1000)).toBe(true);
  });

  it("onIdle returns false on timeout when work is still hung", async () => {
    const reg = new LimiterRegistry({ default: 1, perProvider: new Map() });
    let _gate: (() => void) | null = null;
    const hung = reg.run("p", async () => {
      await new Promise<void>((resolve) => {
        _gate = resolve;
      });
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    reg.pause();
    expect(await reg.onIdle(20)).toBe(false);
    // Cleanup: let the hung promise resolve so bun:test doesn't keep
    // the process alive.
    _gate!();
    await hung;
  });
});

describe("LimiterRegistry — queue-depth alert", () => {
  it("emits one alert when depth > threshold for ≥ dwellMs", async () => {
    const alerts: Array<{ providerId: string; depth: number; dwellMs: number }> = [];
    let now = 0;
    const reg = new LimiterRegistry(
      { default: 1, perProvider: new Map() },
      {
        queueDepthAlertThreshold: 2,
        queueDepthDwellMs: 100,
        queueDepthPollMs: 25,
        alertSink: (line) => alerts.push(line),
        now: () => now,
      },
    );
    // Fire 5 calls against a 1-concurrency lane. 1 active, 4 parked.
    const gates: Array<() => void> = [];
    const inflight: Array<Promise<unknown>> = [];
    for (let i = 0; i < 5; i++) {
      inflight.push(reg.run("p", () => new Promise<void>((r) => gates.push(r))));
    }
    // Yield so the active task reaches its gate and the parked count
    // reflects the steady state.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // T=0: depth=4 > 2 → arm.
    reg.checkQueueDepth();
    expect(alerts.length).toBe(0);
    // T=50: still parked, dwell 50ms < 100ms → no alert.
    now = 50;
    reg.checkQueueDepth();
    expect(alerts.length).toBe(0);
    // T=150: dwell 150ms ≥ 100ms → fire once.
    now = 150;
    reg.checkQueueDepth();
    expect(alerts.length).toBe(1);
    expect(alerts[0]?.providerId).toBe("p");
    expect(alerts[0]?.depth).toBe(4);
    expect(alerts[0]?.dwellMs).toBeGreaterThanOrEqual(100);
    // T=200: re-check while still over threshold — must NOT spam.
    now = 200;
    reg.checkQueueDepth();
    expect(alerts.length).toBe(1);
    reg.dispose();
    // Drain so bun:test exits cleanly.
    while (gates.length > 0) {
      gates.shift()!();
      for (let i = 0; i < 50; i++) await Promise.resolve();
    }
    await Promise.all(inflight);
  });

  it("re-arms after depth drops below threshold then crosses it again", async () => {
    const alerts: Array<{ providerId: string; depth: number; dwellMs: number }> = [];
    let now = 0;
    const reg = new LimiterRegistry(
      { default: 1, perProvider: new Map() },
      {
        queueDepthAlertThreshold: 1,
        queueDepthDwellMs: 50,
        queueDepthPollMs: 25,
        alertSink: (line) => alerts.push(line),
        now: () => now,
      },
    );
    // Build a backlog: 1 active + 2 parked = depth 2.
    const gates: Array<() => void> = [];
    const inflight: Array<Promise<unknown>> = [];
    for (let i = 0; i < 3; i++) {
      inflight.push(reg.run("p", () => new Promise<void>((r) => gates.push(r))));
    }
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // Arm + dwell + first alert.
    reg.checkQueueDepth();
    now = 100;
    reg.checkQueueDepth();
    expect(alerts.length).toBe(1);
    // Drop below threshold — release every task.
    while (gates.length > 0) {
      gates.shift()!();
      for (let i = 0; i < 50; i++) await Promise.resolve();
    }
    await Promise.all(inflight);
    // Check below-threshold: alert state resets.
    now = 200;
    reg.checkQueueDepth();
    expect(alerts.length).toBe(1);
    // Cross threshold again with fresh parked work.
    const gates2: Array<() => void> = [];
    const inflight2: Array<Promise<unknown>> = [];
    for (let i = 0; i < 3; i++) {
      inflight2.push(reg.run("p", () => new Promise<void>((r) => gates2.push(r))));
    }
    for (let i = 0; i < 20; i++) await Promise.resolve();
    reg.checkQueueDepth();
    now = 300;
    reg.checkQueueDepth();
    // Re-armed → second alert (sliding state, not stuck).
    expect(alerts.length).toBe(2);
    reg.dispose();
    while (gates2.length > 0) {
      gates2.shift()!();
      for (let i = 0; i < 50; i++) await Promise.resolve();
    }
    await Promise.all(inflight2);
  });
});

describe("LimiterRegistry — snapshot", () => {
  it("reports per-provider concurrency, pending, and active counts", async () => {
    const reg = new LimiterRegistry({
      default: 1,
      perProvider: new Map([["fast", 3]]),
    });
    const gates: Array<() => void> = [];
    // 3 active + 1 parked on `fast` (concurrency 3, 4 calls).
    // 1 active + 2 parked on `slow` (concurrency 1, 3 calls).
    const inflight: Array<Promise<unknown>> = [];
    for (let i = 0; i < 4; i++) {
      inflight.push(reg.run("fast", () => new Promise<void>((r) => gates.push(r))));
    }
    for (let i = 0; i < 3; i++) {
      inflight.push(reg.run("slow", () => new Promise<void>((r) => gates.push(r))));
    }
    for (let i = 0; i < 30; i++) await Promise.resolve();
    const snap = reg.snapshot();
    const fast = snap.find((s) => s.providerId === "fast");
    const slow = snap.find((s) => s.providerId === "slow");
    expect(fast?.concurrency).toBe(3);
    expect(fast?.active).toBe(3);
    expect(fast?.pending).toBe(1);
    expect(slow?.concurrency).toBe(1);
    expect(slow?.active).toBe(1);
    expect(slow?.pending).toBe(2);
    // Drain everything so bun:test exits cleanly.
    while (gates.length > 0) {
      gates.shift()!();
      for (let i = 0; i < 50; i++) await Promise.resolve();
    }
    await Promise.all(inflight);
  });
});
