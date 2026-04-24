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
