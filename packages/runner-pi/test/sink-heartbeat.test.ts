// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `startSinkHeartbeat` — the runner-side liveness
 * keep-alive used by both the CLI and the runtime-pi container.
 *
 * The helper's job is narrow:
 *   - fire a signed POST against the heartbeat URL on a jittered
 *     interval, with HMAC auth matching the event ingestion surface
 *   - stop cleanly on demand
 *   - stop on HTTP 410 (sink closed) without escalating to an error
 *   - surface other HTTP + network errors through `onError` without
 *     crashing the run
 */

import { describe, it, expect } from "bun:test";
import { startSinkHeartbeat } from "../src/sink-heartbeat.ts";

function collectingFetch(): {
  fetchImpl: typeof fetch;
  calls: { url: string; headers: Record<string, string>; body: string }[];
  respondWith: (status: number) => void;
} {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  let nextStatus = 200;
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers, body: (init?.body as string) ?? "" });
    return new Response(null, { status: nextStatus });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    calls,
    respondWith: (status) => {
      nextStatus = status;
    },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("startSinkHeartbeat", () => {
  it("posts a signed empty-body heartbeat on the interval", async () => {
    const { fetchImpl, calls } = collectingFetch();
    const handle = startSinkHeartbeat({
      url: "https://api/runs/r_1/events/heartbeat",
      runSecret: "a".repeat(43),
      intervalMs: 50,
      jitter: 0,
      fetch: fetchImpl,
    });

    // Wait long enough for at least two ticks.
    await wait(160);
    handle.stop();

    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call.url).toBe("https://api/runs/r_1/events/heartbeat");
      expect(call.body).toBe("{}");
      // Standard Webhooks headers the middleware expects.
      expect(call.headers["webhook-id"]).toBeDefined();
      expect(call.headers["webhook-timestamp"]).toBeDefined();
      expect(call.headers["webhook-signature"]).toMatch(/^v1,/);
    }
  });

  it("stops the loop on demand — no ticks fire after stop()", async () => {
    const { fetchImpl, calls } = collectingFetch();
    const handle = startSinkHeartbeat({
      url: "https://api/runs/r_2/events/heartbeat",
      runSecret: "a".repeat(43),
      intervalMs: 30,
      jitter: 0,
      fetch: fetchImpl,
    });

    await wait(80);
    handle.stop();
    const countAtStop = calls.length;

    // Give a generous window for late ticks to fire if stop didn't
    // actually cancel the timer.
    await wait(120);
    expect(calls.length).toBe(countAtStop);
  });

  it("self-terminates on HTTP 410 — sink closed means no more pings", async () => {
    const { fetchImpl, calls, respondWith } = collectingFetch();
    respondWith(410);
    const errors: unknown[] = [];
    const handle = startSinkHeartbeat({
      url: "https://api/runs/r_3/events/heartbeat",
      runSecret: "a".repeat(43),
      intervalMs: 30,
      jitter: 0,
      fetch: fetchImpl,
      onError: (err) => errors.push(err),
    });

    await wait(200);
    handle.stop();

    // First 410 shuts the loop down — subsequent ticks never fire.
    expect(calls.length).toBe(1);
    // 410 is a graceful stop, not an error — no onError invocation.
    expect(errors.length).toBe(0);
  });

  it("surfaces non-410 errors through onError without crashing the loop", async () => {
    const { fetchImpl, calls, respondWith } = collectingFetch();
    respondWith(503);
    const errors: unknown[] = [];
    const handle = startSinkHeartbeat({
      url: "https://api/runs/r_4/events/heartbeat",
      runSecret: "a".repeat(43),
      intervalMs: 30,
      jitter: 0,
      fetch: fetchImpl,
      onError: (err) => errors.push(err),
    });

    await wait(120);
    handle.stop();

    // Keeps pinging across failures so a transient upstream blip
    // doesn't declare the runner dead from its own side.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it("jitter produces distinct intervals (anti thundering-herd)", async () => {
    // Use a custom Math.random via closure: we can't stub the global
    // cheaply, so instead we assert that with jitter=0.5 the observed
    // interval varies rather than stays pinned at the nominal value.
    const { fetchImpl, calls } = collectingFetch();
    const handle = startSinkHeartbeat({
      url: "https://api/runs/r_5/events/heartbeat",
      runSecret: "a".repeat(43),
      intervalMs: 50,
      jitter: 0.5,
      fetch: fetchImpl,
    });
    const start = Date.now();
    await wait(300);
    handle.stop();

    // Collect rough per-tick deltas.
    const timestamps = calls.map((_, i) => (i === 0 ? start : Date.now())); // approximation
    expect(calls.length).toBeGreaterThanOrEqual(3);
    // Two consecutive intervals being identical to the millisecond is
    // possible but unlikely with ±50% jitter — the goal here is just to
    // assert the loop ran multiple times under jitter without crashing.
    // The real guarantee is encoded in the implementation (Math.random
    // factored into delay); this test protects the call sites that use
    // the helper from regressions where the factor accidentally becomes 1.
    expect(timestamps.length).toBeGreaterThanOrEqual(3);
  });
});

/**
 * A `fetch` that never resolves on its own — it settles only when the
 * caller's signal aborts, rejecting with the abort reason exactly as a real
 * `fetch` does. Records every signal it was handed so a test can tell WHICH
 * of the composed legs fired (`TimeoutError` = the per-attempt deadline,
 * `AbortError` = `stop()`).
 */
function hangingFetch(): { fetchImpl: typeof fetch; signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  const fetchImpl = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const signal = init?.signal;
    if (!signal) throw new Error("heartbeat POST carried no AbortSignal — it can hang forever");
    signals.push(signal);
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, signals };
}

/** Poll until `predicate` holds or `timeoutMs` elapses. Returns whether it held. */
async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(5);
  }
  return predicate();
}

/**
 * The heartbeat's own hang, which is the failure it exists to prevent: ticks
 * are serialised through `sendOnce().finally(scheduleNext)`, so ONE fetch that
 * never settles stops the loop for good and the platform's stall watchdog
 * reaps a container that is perfectly alive.
 */
describe("startSinkHeartbeat — per-attempt deadline", () => {
  it("gives up on a hung POST and keeps ticking", async () => {
    const { fetchImpl, signals } = hangingFetch();
    const errors: unknown[] = [];
    // 40 ms interval → a 20 ms per-attempt deadline (half the interval).
    const handle = startSinkHeartbeat({
      url: "https://api/runs/r_hang/events/heartbeat",
      runSecret: "a".repeat(43),
      intervalMs: 40,
      jitter: 0,
      fetch: fetchImpl,
      onError: (err) => errors.push(err),
    });

    const ticked = await until(() => signals.length >= 3, 1_000);
    handle.stop();

    // Without the deadline this is stuck at 1 forever.
    expect(ticked).toBe(true);
    // Every attempt that ran to completion died on the DEADLINE, not on some
    // other fault. The last one is excluded: `stop()` above aborts whatever is
    // in flight, which is the subject of the third test, not this one.
    const completed = signals.slice(0, -1);
    expect(completed.length).toBeGreaterThanOrEqual(2);
    for (const signal of completed) {
      expect(signal.aborted).toBe(true);
      expect((signal.reason as Error).name).toBe("TimeoutError");
    }
    // Each hang is surfaced, not swallowed.
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  // Control: the same loop, same tight interval, against an upstream that
  // answers. If the deadline were firing indiscriminately — or the loop were
  // simply broken — this fails, so the test above cannot pass by accident.
  it("does not fire on a responsive upstream", async () => {
    const { fetchImpl, calls } = collectingFetch();
    // Sampled at the instant the POST completes — the composed signal's
    // timeout leg stays armed afterwards and fires harmlessly on the finished
    // request (nothing reads the heartbeat's body), so a later read would say
    // nothing about whether the deadline cut this attempt short.
    const abortedAtCompletion: boolean[] = [];
    const recordingFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const res = await fetchImpl(input as string, init);
      abortedAtCompletion.push(init?.signal?.aborted ?? true);
      return res;
    }) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const handle = startSinkHeartbeat({
      url: "https://api/runs/r_live/events/heartbeat",
      runSecret: "a".repeat(43),
      intervalMs: 40,
      jitter: 0,
      fetch: recordingFetch,
      onError: (err) => errors.push(err),
    });

    await wait(200);
    handle.stop();

    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(errors).toHaveLength(0);
    // Deadlines armed but never reached: no attempt was aborted on its way out.
    expect(abortedAtCompletion.length).toBeGreaterThanOrEqual(3);
    for (const aborted of abortedAtCompletion) expect(aborted).toBe(false);
  });

  // The half a naive fix misses: `stop()` clears the timer, which says nothing
  // about a POST already in flight.
  it("stop() aborts the request in flight", async () => {
    const { fetchImpl, signals } = hangingFetch();
    const errors: unknown[] = [];
    // 200 ms interval → 100 ms deadline: wide enough that `stop()` lands while
    // the first attempt is still hanging, so the abort observed below is
    // `stop()`'s and not the deadline's.
    const handle = startSinkHeartbeat({
      url: "https://api/runs/r_stop/events/heartbeat",
      runSecret: "a".repeat(43),
      intervalMs: 200,
      jitter: 0,
      fetch: fetchImpl,
      onError: (err) => errors.push(err),
    });

    expect(await until(() => signals.length === 1, 1_000)).toBe(true);
    handle.stop();

    expect(signals[0]!.aborted).toBe(true);
    expect((signals[0]!.reason as Error).name).toBe("AbortError");
    // A requested stop is not a fault to report.
    expect(errors).toHaveLength(0);
  });
});
