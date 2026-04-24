// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the Pi SDK → RunEvent bridge.
 *
 * The bridge is pure (no async, no side effects beyond `sink.emit`) so
 * we feed it hand-rolled Pi SDK events and assert on the captured
 * RunEvents. Every event type documented in the module docstring must
 * have at least one test here — if a new mapping is added to the
 * bridge, add its test here too.
 */

import { describe, it, expect } from "bun:test";
import { installSessionBridge, type InternalSink } from "../src/pi-runner.ts";
import { createFakeSession, createInternalCapture } from "./helpers.ts";

const RUN_ID = "run_bridge_test";

describe("installSessionBridge — message_update / text_delta", () => {
  it("does NOT forward text_delta streaming chunks (message_end carries the full text)", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    // Burst of deltas — historically these each turned into an
    // `appstrate.progress`. We stopped forwarding them to avoid
    // 1000× signed POSTs / run_logs inserts per long assistant reply;
    // the `message_end` mapping still surfaces the assembled text.
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello " },
    });
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "world" },
    });
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta" }, // delta: undefined
    });

    expect(sink.events).toHaveLength(0);
  });
});

describe("installSessionBridge — message_end", () => {
  it("emits appstrate.progress with full assistant text", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    session.pushMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Line one" },
        { type: "text", text: "Line two" },
      ],
    });
    session.emit({ type: "message_end" });

    const textEvent = sink.events.find((e) => e.type === "appstrate.progress");
    expect(textEvent).toBeDefined();
    expect((textEvent as unknown as { message: string }).message).toBe("Line one\nLine two");
  });

  it("emits appstrate.error when stopReason is error", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    session.pushMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: "LLM timeout",
      content: [],
    });
    session.emit({ type: "message_end" });

    const errorEvent = sink.events.find((e) => e.type === "appstrate.error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as unknown as { message: string }).message).toBe("LLM timeout");
  });

  it("ignores message_end when no assistant message was pushed", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    session.emit({ type: "message_end" });
    expect(sink.events).toHaveLength(0);
  });

  it("ignores message_end when last message is not from assistant", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    session.pushMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
    session.emit({ type: "message_end" });

    expect(sink.events).toHaveLength(0);
  });

  it("skips non-text content parts when assembling progress text", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    session.pushMessage({
      role: "assistant",
      content: [{ type: "text", text: "visible" }, { type: "image" }, { type: "tool_use" }],
    });
    session.emit({ type: "message_end" });

    const textEvent = sink.events.find((e) => e.type === "appstrate.progress");
    expect(textEvent).toBeDefined();
    expect((textEvent as unknown as { message: string }).message).toBe("visible");
  });

  it("skips progress emit when assembled text is empty", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    session.pushMessage({
      role: "assistant",
      content: [{ type: "text", text: "" }],
    });
    session.emit({ type: "message_end" });

    expect(sink.events).toHaveLength(0);
  });
});

describe("installSessionBridge — tool_execution_start", () => {
  it("emits appstrate.progress with tool + args data", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    session.emit({
      type: "tool_execution_start",
      toolName: "read_file",
      args: { path: "/tmp/x" },
    });

    expect(sink.events).toHaveLength(1);
    const ev = sink.events[0] as unknown as {
      type: string;
      message: string;
      data: { tool: string; args: unknown };
    };
    expect(ev.type).toBe("appstrate.progress");
    expect(ev.message).toBe("Tool: read_file");
    expect(ev.data).toEqual({ tool: "read_file", args: { path: "/tmp/x" } });
  });

  it("falls back to 'unknown' when toolName is missing", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    session.emit({ type: "tool_execution_start" });

    expect((sink.events[0] as unknown as { message: string }).message).toBe("Tool: unknown");
  });
});

describe("installSessionBridge — agent_end + usage accumulation", () => {
  it("emits appstrate.metric with zero totals when no messages have usage", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    session.emit({ type: "agent_end" });

    const metric = sink.events.find((e) => e.type === "appstrate.metric");
    expect(metric).toBeDefined();
    expect((metric as unknown as { usage: { input_tokens: number } }).usage.input_tokens).toBe(0);
    expect((metric as unknown as { cost: number }).cost).toBe(0);
  });

  it("accumulates usage across multiple assistant messages", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    // First turn
    session.pushMessage({
      role: "assistant",
      usage: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2, cost: { total: 0.001 } },
      content: [{ type: "text", text: "a" }],
    });
    session.emit({ type: "message_end" });

    // Second turn
    session.pushMessage({
      role: "assistant",
      usage: { input: 5, output: 15, cacheRead: 0, cacheWrite: 3, cost: { total: 0.002 } },
      content: [{ type: "text", text: "b" }],
    });
    session.emit({ type: "message_end" });

    session.emit({ type: "agent_end" });

    const metric = sink.events.find((e) => e.type === "appstrate.metric") as unknown as {
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
      };
      cost: number;
    };
    expect(metric.usage.input_tokens).toBe(15);
    expect(metric.usage.output_tokens).toBe(35);
    expect(metric.usage.cache_creation_input_tokens).toBe(5);
    expect(metric.usage.cache_read_input_tokens).toBe(1);
    expect(metric.cost).toBeCloseTo(0.003, 5);
  });

  it("tolerates missing usage.cost on individual messages", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    session.pushMessage({
      role: "assistant",
      usage: { input: 1, output: 2 }, // no cost object
      content: [{ type: "text", text: "x" }],
    });
    session.emit({ type: "message_end" });
    session.emit({ type: "agent_end" });

    const metric = sink.events.find((e) => e.type === "appstrate.metric") as unknown as {
      cost: number;
    };
    expect(metric.cost).toBe(0);
  });
});

describe("installSessionBridge — non-mapped events", () => {
  it("ignores events of unknown type silently", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    session.emit({ type: "turn_start" });
    session.emit({ type: "turn_end" });
    session.emit({ type: "some_future_event", payload: {} });

    expect(sink.events).toHaveLength(0);
  });
});

describe("installSessionBridge — wire envelope guarantees", () => {
  it("every emitted event carries the runId", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    session.emit({ type: "tool_execution_start", toolName: "t" });
    session.emit({ type: "agent_end" });

    expect(sink.events.length).toBeGreaterThan(0);
    for (const ev of sink.events) {
      expect(ev.runId).toBe(RUN_ID);
    }
  });

  it("every emitted event carries a numeric timestamp", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    session.emit({ type: "tool_execution_start", toolName: "t" });
    session.emit({ type: "agent_end" });

    expect(sink.events.length).toBeGreaterThan(0);
    for (const ev of sink.events) {
      expect(typeof ev.timestamp).toBe("number");
      expect(ev.timestamp).toBeGreaterThan(0);
    }
  });
});

describe("installSessionBridge — getCost()", () => {
  // The bridge's cost accumulator is the authoritative cost source
  // threaded into RunResult.cost at finalize. The platform synthesises
  // a runner-source `llm_usage` ledger row from this value when the
  // metric event POST never landed, so cost accounting is independent
  // of the side-channel's timing.
  it("returns 0 before any messages have arrived", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    const bridge = installSessionBridge(session, sink, RUN_ID);

    expect(bridge.getCost()).toBe(0);
  });

  it("accumulates cost across each message_end", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    const bridge = installSessionBridge(session, sink, RUN_ID);

    session.pushMessage({
      role: "assistant",
      usage: { input: 10, output: 20, cost: { total: 0.001 } },
      content: [{ type: "text", text: "a" }],
    });
    session.emit({ type: "message_end" });
    expect(bridge.getCost()).toBeCloseTo(0.001, 5);

    session.pushMessage({
      role: "assistant",
      usage: { input: 5, output: 15, cost: { total: 0.002 } },
      content: [{ type: "text", text: "b" }],
    });
    session.emit({ type: "message_end" });
    expect(bridge.getCost()).toBeCloseTo(0.003, 5);
  });

  it("matches the cost carried on the appstrate.metric event", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    const bridge = installSessionBridge(session, sink, RUN_ID);

    session.pushMessage({
      role: "assistant",
      usage: { input: 100, output: 200, cost: { total: 0.005 } },
      content: [{ type: "text", text: "x" }],
    });
    session.emit({ type: "message_end" });
    session.emit({ type: "agent_end" });

    const metric = sink.events.find((e) => e.type === "appstrate.metric") as unknown as {
      cost: number;
    };
    expect(metric.cost).toBeCloseTo(bridge.getCost(), 5);
  });
});

describe("installSessionBridge — getUsage()", () => {
  // The bridge's accumulator is the authoritative usage source threaded
  // into RunResult.usage at finalize. The platform reads it directly
  // from the finalize body, removing the dependency on the metric event
  // POST having been ingested first.
  it("returns zeroed usage before any messages have arrived", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    const bridge = installSessionBridge(session, sink, RUN_ID);

    expect(bridge.getUsage()).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("reflects accumulated usage after each message_end", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    const bridge = installSessionBridge(session, sink, RUN_ID);

    session.pushMessage({
      role: "assistant",
      usage: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 },
      content: [{ type: "text", text: "a" }],
    });
    session.emit({ type: "message_end" });

    expect(bridge.getUsage()).toEqual({
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 1,
    });

    session.pushMessage({
      role: "assistant",
      usage: { input: 5, output: 15, cacheRead: 3, cacheWrite: 4 },
      content: [{ type: "text", text: "b" }],
    });
    session.emit({ type: "message_end" });

    expect(bridge.getUsage()).toEqual({
      input_tokens: 15,
      output_tokens: 35,
      cache_creation_input_tokens: 6,
      cache_read_input_tokens: 4,
    });
  });

  it("matches the usage carried on the appstrate.metric event", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    const bridge = installSessionBridge(session, sink, RUN_ID);

    session.pushMessage({
      role: "assistant",
      usage: { input: 100, output: 200, cacheRead: 5, cacheWrite: 10 },
      content: [{ type: "text", text: "x" }],
    });
    session.emit({ type: "message_end" });
    session.emit({ type: "agent_end" });

    const metric = sink.events.find((e) => e.type === "appstrate.metric") as unknown as {
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };
    expect(metric.usage).toEqual(bridge.getUsage());
  });
});

describe("installSessionBridge — fire-and-forget rejection handling", () => {
  // The bridge calls `sink.emit(event).catch(() => {})` from the
  // synchronous Pi SDK callback. A rejected emit MUST NOT bubble out as
  // an unhandled promise rejection — the SDK callback returns void and
  // has nowhere to receive an error.
  it("does not throw or reject when sink.emit rejects", async () => {
    const failingSink: InternalSink = {
      emit: async () => {
        throw new Error("network failure");
      },
    };
    const session = createFakeSession();
    const bridge = installSessionBridge(session, failingSink, RUN_ID);

    // The synchronous emit MUST return cleanly even when the sink throws
    // asynchronously. Yield a microtask so the rejected promise's
    // `.catch(() => {})` runs before the test asserts no unhandled
    // rejections were raised.
    expect(() => session.emit({ type: "agent_end" })).not.toThrow();
    await Promise.resolve();

    // Accumulators still work after a failing emit — failure is purely
    // local to the emit and doesn't corrupt bridge state.
    expect(bridge.getUsage().input_tokens).toBe(0);
    expect(bridge.getCost()).toBe(0);
  });
});
