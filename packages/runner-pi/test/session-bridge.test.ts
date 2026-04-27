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
import { installSessionBridge, truncateToolResult, type InternalSink } from "../src/pi-runner.ts";
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

describe("installSessionBridge — tool_execution_end", () => {
  it("emits appstrate.progress with tool + result data on success", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    session.emit({
      type: "tool_execution_end",
      toolName: "read_file",
      result: "file contents here",
      isError: false,
    });

    expect(sink.events).toHaveLength(1);
    const ev = sink.events[0] as unknown as {
      type: string;
      message: string;
      data: { tool: string; result: unknown; isError: boolean };
    };
    expect(ev.type).toBe("appstrate.progress");
    expect(ev.message).toBe("Tool result: read_file");
    expect(ev.data).toEqual({
      tool: "read_file",
      result: "file contents here",
      isError: false,
    });
  });

  it("emits with isError=true and 'Tool error:' prefix on error", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    session.emit({
      type: "tool_execution_end",
      toolName: "bash",
      result: "command not found",
      isError: true,
    });

    const ev = sink.events[0] as unknown as {
      message: string;
      data: { isError: boolean };
    };
    expect(ev.message).toBe("Tool error: bash");
    expect(ev.data.isError).toBe(true);
  });

  it("falls back to 'unknown' when toolName is missing", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    session.emit({ type: "tool_execution_end", result: "x" });

    expect((sink.events[0] as unknown as { message: string }).message).toBe("Tool result: unknown");
  });

  it("normalises missing isError to false", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    session.emit({ type: "tool_execution_end", toolName: "t", result: 1 });

    const ev = sink.events[0] as unknown as { data: { isError: boolean } };
    expect(ev.data.isError).toBe(false);
  });

  it("truncates oversized string results before emit", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    const big = "x".repeat(5000);
    session.emit({
      type: "tool_execution_end",
      toolName: "bash",
      result: big,
      isError: false,
    });

    const ev = sink.events[0] as unknown as { data: { result: string } };
    expect(typeof ev.data.result).toBe("string");
    expect(ev.data.result.length).toBeLessThan(big.length);
    expect(ev.data.result).toContain("(truncated, 5000 bytes)");
  });

  it("truncates oversized object results into a structured marker", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    // 4 KB JSON payload — well above the 2 KB ceiling.
    const huge = { lines: Array.from({ length: 200 }, (_, i) => `line ${i} `.repeat(2)) };
    session.emit({
      type: "tool_execution_end",
      toolName: "read_file",
      result: huge,
      isError: false,
    });

    const ev = sink.events[0] as unknown as {
      data: {
        result: { __truncated: true; reason: string; bytes: number; preview: string };
      };
    };
    expect(ev.data.result).toMatchObject({
      __truncated: true,
      reason: "size",
    });
    expect(ev.data.result.bytes).toBeGreaterThan(2048);
    expect(typeof ev.data.result.preview).toBe("string");
  });

  it("passes small object results through untouched", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    const small = { ok: true, count: 42 };
    session.emit({
      type: "tool_execution_end",
      toolName: "noop",
      result: small,
      isError: false,
    });

    const ev = sink.events[0] as unknown as { data: { result: typeof small } };
    expect(ev.data.result).toEqual(small);
  });

  it("preserves null and undefined results without truncation", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    session.emit({ type: "tool_execution_end", toolName: "a", result: null });
    session.emit({ type: "tool_execution_end", toolName: "b", result: undefined });

    expect((sink.events[0] as unknown as { data: { result: unknown } }).data.result).toBe(null);
    expect((sink.events[1] as unknown as { data: { result: unknown } }).data.result).toBe(
      undefined,
    );
  });

  it("handles non-serialisable (circular) results with a structured marker", () => {
    const sink = createInternalCapture();
    const session = createFakeSession();
    installSessionBridge(session, sink, RUN_ID);

    const circ: Record<string, unknown> = {};
    circ.self = circ;
    session.emit({
      type: "tool_execution_end",
      toolName: "loopy",
      result: circ,
      isError: false,
    });

    const ev = sink.events[0] as unknown as { data: { result: unknown } };
    expect(ev.data.result).toEqual({ __truncated: true, reason: "non_serialisable" });
  });
});

describe("truncateToolResult", () => {
  it("returns null/undefined verbatim", () => {
    expect(truncateToolResult(null)).toBe(null);
    expect(truncateToolResult(undefined)).toBe(undefined);
  });

  it("returns primitives verbatim regardless of size", () => {
    expect(truncateToolResult(42)).toBe(42);
    expect(truncateToolResult(true)).toBe(true);
    expect(truncateToolResult(false)).toBe(false);
  });

  it("returns short strings unchanged", () => {
    expect(truncateToolResult("hello")).toBe("hello");
  });

  it("truncates strings exceeding the byte limit with a marker", () => {
    const out = truncateToolResult("a".repeat(3000)) as string;
    expect(out.length).toBeLessThan(3000);
    expect(out).toContain("(truncated, 3000 bytes)");
  });

  it("respects a custom byte limit", () => {
    const out = truncateToolResult("hello world", 5) as string;
    expect(out).toContain("(truncated, ");
    // Boundary safety: content before the marker must be ≤ limit bytes.
    const head = out.split("…")[0];
    expect(Buffer.byteLength(head!, "utf8")).toBeLessThanOrEqual(5);
  });

  it("never produces invalid UTF-8 when truncating multibyte strings", () => {
    // 3-byte UTF-8 chars repeated past the limit — the truncator must
    // step back to a code-point boundary.
    const s = "日".repeat(2000);
    const out = truncateToolResult(s, 100) as string;
    expect(() => new TextEncoder().encode(out)).not.toThrow();
    // Round-trip via Buffer to check no replacement chars.
    const head = out.split("…")[0]!;
    expect(head.length).toBeGreaterThan(0);
    // Each character must be the original 3-byte ideograph.
    for (const ch of head) expect(ch).toBe("日");
  });

  it("returns small objects unchanged", () => {
    const obj = { a: 1, b: "two" };
    expect(truncateToolResult(obj)).toBe(obj);
  });

  it("returns a structured marker for oversized objects", () => {
    const big = { data: "x".repeat(3000) };
    const out = truncateToolResult(big) as Record<string, unknown>;
    expect(out.__truncated).toBe(true);
    expect(out.reason).toBe("size");
    expect(typeof out.bytes).toBe("number");
    expect((out.bytes as number) > 2048).toBe(true);
    expect(out.limit).toBe(2048);
    expect(typeof out.preview).toBe("string");
  });

  it("returns a structured marker for non-serialisable inputs", () => {
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    expect(truncateToolResult(circ)).toEqual({
      __truncated: true,
      reason: "non_serialisable",
    });
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
