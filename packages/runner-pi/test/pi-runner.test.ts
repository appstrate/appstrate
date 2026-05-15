// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for {@link PiRunner.run} — orchestration logic: event
 * forwarding, cancellation via AbortSignal, error path + finalize
 * semantics. Pi SDK is replaced by a scripted subclass so these tests
 * run in <5ms each with no network / FS / subprocess involvement.
 */

import { describe, it, expect } from "bun:test";
import {
  createCaptureSink,
  makeBundlePackage,
  makeContext,
  makeTestBundle,
  ScriptedPiRunner,
} from "./helpers.ts";
import { emptyRunResult } from "@appstrate/afps-runtime/runner";

const STUB_BUNDLE = makeTestBundle(makeBundlePackage("@test/stub", "0.0.0", "agent", {}));

describe("PiRunner.run — event forwarding", () => {
  it("forwards bridge-emitted events to the caller's EventSink before finalize", async () => {
    const sink = createCaptureSink();
    const runner = new ScriptedPiRunner(async (session) => {
      session.emit({ type: "tool_execution_start", toolName: "read_file" });
      session.emit({ type: "agent_end" });
    });

    await runner.run({
      bundle: STUB_BUNDLE,
      context: makeContext(),
      providerResolver: { resolve: async () => [] },
      eventSink: sink,
    });

    // Two from the bridge: progress + metric
    expect(sink.events).toHaveLength(2);
    expect(sink.events[0]!.type).toBe("appstrate.progress");
    expect(sink.events[1]!.type).toBe("appstrate.metric");
    expect(sink.finalizeCalls).toBe(1);
    expect(sink.finalized).not.toBeNull();
  });

  it("finalizes with emptyRunResult when no events were emitted", async () => {
    const sink = createCaptureSink();
    const runner = new ScriptedPiRunner(async () => {
      // No events at all
    });

    await runner.run({
      bundle: STUB_BUNDLE,
      context: makeContext(),
      providerResolver: { resolve: async () => [] },
      eventSink: sink,
    });

    expect(sink.events).toHaveLength(0);
    expect(sink.finalizeCalls).toBe(1);
    // The bridge was installed but no message_end ever fired, so usage
    // and cost are attached with zero counters — this is the
    // authoritative signal the platform's `runHadZeroTokens` heuristic
    // relies on to flip the run to "failed" with the LLM-unreachable
    // message. Cost=0 also tells finalize there is nothing to write to
    // the runner ledger from the body.
    expect(sink.finalized).toEqual({
      ...emptyRunResult(),
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      cost: 0,
    });
  });

  it("preserves order: every event.handle() resolves before finalize runs", async () => {
    const order: string[] = [];
    const sink = createCaptureSink();
    // Re-wrap handle/finalize to record call order.
    const handleOrig = sink.handle.bind(sink);
    sink.handle = async (ev) => {
      order.push(`handle:${ev.type}`);
      await handleOrig(ev);
    };
    const finalizeOrig = sink.finalize.bind(sink);
    sink.finalize = async (r) => {
      order.push("finalize");
      await finalizeOrig(r);
    };

    const runner = new ScriptedPiRunner(async (session) => {
      session.emit({ type: "tool_execution_start", toolName: "one" });
      session.emit({ type: "tool_execution_start", toolName: "two" });
    });

    await runner.run({
      bundle: STUB_BUNDLE,
      context: makeContext(),
      providerResolver: { resolve: async () => [] },
      eventSink: sink,
    });

    // Both handle calls before finalize
    expect(order).toEqual(["handle:appstrate.progress", "handle:appstrate.progress", "finalize"]);
  });
});

describe("PiRunner.run — usage in RunResult", () => {
  // Authoritative usage rides on the finalize POST so the platform's
  // zero-tokens heuristic does not race with the (fire-and-forget)
  // `appstrate.metric` event POST. Without this the finalize endpoint
  // would read a stale `runs.tokenUsage = 0` and flip the run to
  // "failed: could not reach the LLM API" even though the LLM responded.
  it("attaches the bridge's usage accumulator to result.usage", async () => {
    const sink = createCaptureSink();
    const runner = new ScriptedPiRunner(async (session) => {
      session.pushMessage({
        role: "assistant",
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
        content: [{ type: "text", text: "ok" }],
      });
      session.emit({ type: "message_end" });
      session.emit({ type: "agent_end" });
    });

    await runner.run({
      bundle: STUB_BUNDLE,
      context: makeContext(),
      providerResolver: { resolve: async () => [] },
      eventSink: sink,
    });

    expect(sink.finalized?.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("attaches the bridge's cost accumulator to result.cost", async () => {
    const sink = createCaptureSink();
    const runner = new ScriptedPiRunner(async (session) => {
      session.pushMessage({
        role: "assistant",
        usage: { input: 100, output: 50, cost: { total: 0.0042 } },
        content: [{ type: "text", text: "ok" }],
      });
      session.emit({ type: "message_end" });
      session.emit({ type: "agent_end" });
    });

    await runner.run({
      bundle: STUB_BUNDLE,
      context: makeContext(),
      providerResolver: { resolve: async () => [] },
      eventSink: sink,
    });

    // Cost lands in the finalize body so the platform can synthesise
    // the runner-source ledger row even when the metric POST is aborted
    // by `process.exit(0)`.
    expect(sink.finalized?.cost).toBeCloseTo(0.0042, 5);
  });

  it("attaches usage + cost even when executeSession throws (error path)", async () => {
    // The error path branches in `run()` BEFORE the bridge is normally
    // returned. The runner must still surface whatever usage and cost
    // were accumulated up to the failure point so the platform sees
    // the LLM activity that did happen.
    const sink = createCaptureSink();
    const runner = new ScriptedPiRunner(async (session) => {
      // Simulate one assistant turn followed by a crash mid-loop.
      session.pushMessage({
        role: "assistant",
        usage: {
          input: 7,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { total: 0.0001 },
        },
        content: [{ type: "text", text: "partial" }],
      });
      session.emit({ type: "message_end" });
      throw new Error("crash after first turn");
    });

    await runner.run({
      bundle: STUB_BUNDLE,
      context: makeContext(),
      providerResolver: { resolve: async () => [] },
      eventSink: sink,
    });

    expect(sink.finalized?.error?.message).toBe("crash after first turn");
    expect(sink.finalized?.usage).toEqual({
      input_tokens: 7,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(sink.finalized?.cost).toBeCloseTo(0.0001, 5);
  });
});

describe("PiRunner.run — non-blocking event delivery", () => {
  // Pi SDK's executeToolCallsParallel `await emit(...)` on every
  // tool_execution_start / tool_execution_end. If the runner's internal
  // emit awaits the sink's HTTP POST, a 10-tool parallel turn pays 20×
  // network RTT just for telemetry — the agent loop freezes between
  // events. The runner unblocks Pi SDK by resolving emit immediately
  // and draining pending posts before finalize.

  it("does not block the agent loop on slow eventSink.handle", async () => {
    // Slow sink: each handle takes 50ms. With 10 events, a blocking
    // emit would force the script to wait ≥500ms before agent_end
    // returns. The non-blocking emit must let the script complete in
    // well under that — the 50ms penalty is paid once, after finalize.
    const HANDLE_LATENCY_MS = 50;
    const EVENT_COUNT = 10;

    const sink = createCaptureSink();
    const baseHandle = sink.handle.bind(sink);
    sink.handle = async (ev) => {
      await new Promise((r) => setTimeout(r, HANDLE_LATENCY_MS));
      await baseHandle(ev);
    };

    let scriptElapsed = 0;
    const runner = new ScriptedPiRunner(async (session) => {
      const start = performance.now();
      for (let i = 0; i < EVENT_COUNT; i++) {
        session.emit({ type: "tool_execution_start", toolName: `tool_${i}` });
      }
      session.emit({ type: "agent_end" });
      scriptElapsed = performance.now() - start;
    });

    await runner.run({
      bundle: STUB_BUNDLE,
      context: makeContext(),
      providerResolver: { resolve: async () => [] },
      eventSink: sink,
    });

    // Script body finished without serialising on the per-event 50ms
    // latency. Generous ceiling — anything ≥ EVENT_COUNT * latency means
    // we re-introduced the blocking await.
    expect(scriptElapsed).toBeLessThan((EVENT_COUNT * HANDLE_LATENCY_MS) / 2);

    // Every event still reached the sink — drain runs before finalize.
    expect(sink.events.length).toBe(EVENT_COUNT + 1); // 10 progress + 1 metric (agent_end)
    expect(sink.finalizeCalls).toBe(1);
  });

  it("awaits all in-flight event posts before calling finalize", async () => {
    // Even though emit is non-blocking, finalize must observe the same
    // event prefix the platform has already ingested. The drain step
    // before finalize guarantees handle() has resolved for every
    // emitted event.
    const order: string[] = [];
    const sink = createCaptureSink();

    sink.handle = async (ev) => {
      // Asymmetric latency so handles complete in reverse order if the
      // drain is missing — finalize would otherwise race past them.
      const delay = ev.type === "appstrate.progress" ? 30 : 5;
      await new Promise((r) => setTimeout(r, delay));
      order.push(`handle:${ev.type}`);
    };
    const baseFinalize = sink.finalize.bind(sink);
    sink.finalize = async (r) => {
      order.push("finalize");
      await baseFinalize(r);
    };

    const runner = new ScriptedPiRunner(async (session) => {
      session.emit({ type: "tool_execution_start", toolName: "slow_one" });
      session.emit({ type: "tool_execution_start", toolName: "slow_two" });
      session.emit({ type: "agent_end" });
    });

    await runner.run({
      bundle: STUB_BUNDLE,
      context: makeContext(),
      providerResolver: { resolve: async () => [] },
      eventSink: sink,
    });

    // Finalize must be last — drain awaited every pending post.
    expect(order[order.length - 1]).toBe("finalize");
    // All three handles completed before finalize.
    expect(order.filter((s) => s.startsWith("handle:"))).toHaveLength(3);
  });

  it("swallows per-event delivery failures so a transient sink error does not crash the run", async () => {
    // HttpSink already retries with exponential backoff. A rejection
    // out of handle() is a permanently-lost event — surfacing it as an
    // unhandled rejection would crash the agent. The runner must
    // catch and continue.
    const sink = createCaptureSink();
    let calls = 0;
    sink.handle = async () => {
      calls += 1;
      if (calls === 2) throw new Error("simulated permanent failure");
    };

    const runner = new ScriptedPiRunner(async (session) => {
      session.emit({ type: "tool_execution_start", toolName: "a" });
      session.emit({ type: "tool_execution_start", toolName: "b" });
      session.emit({ type: "tool_execution_start", toolName: "c" });
      session.emit({ type: "agent_end" });
    });

    // Must not throw — the rejected post is absorbed.
    await runner.run({
      bundle: STUB_BUNDLE,
      context: makeContext(),
      providerResolver: { resolve: async () => [] },
      eventSink: sink,
    });

    expect(sink.finalizeCalls).toBe(1);
    // Every event was attempted (3 progress + 1 metric); one rejected.
    expect(calls).toBe(4);
  });
});

describe("PiRunner.run — error path", () => {
  it("emits appstrate.error + finalize when executeSession throws", async () => {
    const sink = createCaptureSink();
    const runner = new ScriptedPiRunner(async () => {
      throw new Error("LLM API unreachable");
    });

    await runner.run({
      bundle: STUB_BUNDLE,
      context: makeContext(),
      providerResolver: { resolve: async () => [] },
      eventSink: sink,
    });

    const errorEvent = sink.events.find((e) => e.type === "appstrate.error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as unknown as { message: string }).message).toBe("LLM API unreachable");
    expect(sink.finalizeCalls).toBe(1);
    expect(sink.finalized?.error?.message).toBe("LLM API unreachable");
  });

  it("folds non-Error throws into a string message", async () => {
    const sink = createCaptureSink();
    const runner = new ScriptedPiRunner(async () => {
      throw "string error";
    });

    await runner.run({
      bundle: STUB_BUNDLE,
      context: makeContext(),
      providerResolver: { resolve: async () => [] },
      eventSink: sink,
    });

    expect(sink.finalized?.error?.message).toBe("string error");
  });
});

describe("PiRunner.run — cancellation", () => {
  it("throws when signal is already aborted before run()", async () => {
    const sink = createCaptureSink();
    const controller = new AbortController();
    controller.abort(new Error("early cancel"));

    const runner = new ScriptedPiRunner(async () => {
      // Should never execute — the guard at the top of run() throws first.
      throw new Error("script should not run");
    });

    await expect(
      runner.run({
        bundle: STUB_BUNDLE,
        context: makeContext(),
        providerResolver: { resolve: async () => [] },
        eventSink: sink,
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();

    // No finalize when pre-aborted
    expect(sink.finalizeCalls).toBe(0);
  });

  it("propagates cancellation errors WITHOUT finalizing", async () => {
    const sink = createCaptureSink();
    const controller = new AbortController();

    const runner = new ScriptedPiRunner(async (_session, _ctx, signal) => {
      // Simulate: in-flight prompt, then aborted.
      controller.abort(new Error("user cancelled"));
      // The runner's executeSession would normally race the prompt against
      // the abort signal and reject; replicate that here.
      if (signal?.aborted) {
        throw signal.reason ?? new Error("cancelled");
      }
    });

    await expect(
      runner.run({
        bundle: STUB_BUNDLE,
        context: makeContext(),
        providerResolver: { resolve: async () => [] },
        eventSink: sink,
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();

    // Cancellation path: no finalize call — the caller owns post-abort cleanup.
    expect(sink.finalizeCalls).toBe(0);
  });

  it("does not emit appstrate.error on cancellation-path throws", async () => {
    const sink = createCaptureSink();
    const controller = new AbortController();

    const runner = new ScriptedPiRunner(async () => {
      controller.abort();
      throw new Error("cancelled");
    });

    try {
      await runner.run({
        bundle: STUB_BUNDLE,
        context: makeContext(),
        providerResolver: { resolve: async () => [] },
        eventSink: sink,
        signal: controller.signal,
      });
    } catch {
      // expected
    }

    const errorEvent = sink.events.find((e) => e.type === "appstrate.error");
    expect(errorEvent).toBeUndefined();
  });
});

describe("PiRunner.run — Runner contract", () => {
  it("implements Runner.name", () => {
    const runner = new ScriptedPiRunner(async () => {});
    expect(runner.name).toBe("pi-runner");
  });
});
