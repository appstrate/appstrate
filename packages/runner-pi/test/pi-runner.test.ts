// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for {@link PiRunner.run} — orchestration logic: event
 * forwarding, cancellation via AbortSignal, error path + finalize
 * semantics. Pi SDK is replaced by a scripted subclass so these tests
 * run in <5ms each with no network / FS / subprocess involvement.
 */

import { describe, it, expect } from "bun:test";
import { createCaptureSink, makeContext, ScriptedPiRunner } from "./helpers.ts";
import { emptyRunResult } from "@appstrate/afps-runtime/runner";

describe("PiRunner.run — event forwarding", () => {
  it("forwards bridge-emitted events to the caller's EventSink before finalize", async () => {
    const sink = createCaptureSink();
    const runner = new ScriptedPiRunner(async (session) => {
      session.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
      });
      session.emit({ type: "agent_end" });
    });

    await runner.run({
      bundle: {
        manifest: {},
        prompt: "",
        files: {},
        compressedSize: 0,
        decompressedSize: 0,
      },
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
      bundle: {
        manifest: {},
        prompt: "",
        files: {},
        compressedSize: 0,
        decompressedSize: 0,
      },
      context: makeContext(),
      providerResolver: { resolve: async () => [] },
      eventSink: sink,
    });

    expect(sink.events).toHaveLength(0);
    expect(sink.finalizeCalls).toBe(1);
    expect(sink.finalized).toEqual(emptyRunResult());
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
      session.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "one" },
      });
      session.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "two" },
      });
    });

    await runner.run({
      bundle: {
        manifest: {},
        prompt: "",
        files: {},
        compressedSize: 0,
        decompressedSize: 0,
      },
      context: makeContext(),
      providerResolver: { resolve: async () => [] },
      eventSink: sink,
    });

    // Both handle calls before finalize
    expect(order).toEqual(["handle:appstrate.progress", "handle:appstrate.progress", "finalize"]);
  });
});

describe("PiRunner.run — error path", () => {
  it("emits appstrate.error + finalize when executeSession throws", async () => {
    const sink = createCaptureSink();
    const runner = new ScriptedPiRunner(async () => {
      throw new Error("LLM API unreachable");
    });

    await runner.run({
      bundle: {
        manifest: {},
        prompt: "",
        files: {},
        compressedSize: 0,
        decompressedSize: 0,
      },
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
      bundle: {
        manifest: {},
        prompt: "",
        files: {},
        compressedSize: 0,
        decompressedSize: 0,
      },
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
        bundle: {
          manifest: {},
          prompt: "",
          files: {},
          compressedSize: 0,
          decompressedSize: 0,
        },
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
        bundle: {
          manifest: {},
          prompt: "",
          files: {},
          compressedSize: 0,
          decompressedSize: 0,
        },
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
        bundle: {
          manifest: {},
          prompt: "",
          files: {},
          compressedSize: 0,
          decompressedSize: 0,
        },
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
