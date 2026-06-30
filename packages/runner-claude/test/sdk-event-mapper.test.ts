// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { SdkRunEventMapper, type SdkRunMessage } from "../src/sdk-event-mapper.ts";
import { truncateToolResult } from "@appstrate/afps-runtime/runner";

const RUN_ID = "run_test";
const fixedNow = () => 1_700_000_000_000;

function map(mapper: SdkRunEventMapper, msg: SdkRunMessage) {
  return mapper.map(msg);
}

describe("SdkRunEventMapper — assistant messages", () => {
  it("maps assistant text to a single progress event", () => {
    const mapper = new SdkRunEventMapper(RUN_ID, fixedNow);
    const events = map(mapper, {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: "world" },
        ],
      },
    });
    expect(events).toEqual([
      {
        type: "appstrate.progress",
        timestamp: fixedNow(),
        runId: RUN_ID,
        message: "Hello\nworld",
        level: "info",
      },
    ]);
  });

  it("maps tool_use blocks to progress events carrying tool name + args", () => {
    const mapper = new SdkRunEventMapper(RUN_ID, fixedNow);
    const events = map(mapper, {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "search", input: { q: "x" } }],
      },
    });
    expect(events).toEqual([
      {
        type: "appstrate.progress",
        timestamp: fixedNow(),
        runId: RUN_ID,
        message: "Tool: search",
        level: "info",
        data: { tool: "search", args: { q: "x" }, toolCallId: "t1" },
      },
    ]);
  });

  it("emits a usage-only metric (no cost) and accumulates across turns", () => {
    const mapper = new SdkRunEventMapper(RUN_ID, fixedNow);
    const a = map(mapper, {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "a" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    const b = map(mapper, {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "b" }],
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    });
    const metricA = a.find((e) => e.type === "appstrate.metric") as Record<string, unknown>;
    const metricB = b.find((e) => e.type === "appstrate.metric") as Record<string, unknown>;
    expect(metricA.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(metricA.cost).toBeUndefined();
    expect(metricB.usage).toEqual({
      input_tokens: 13,
      output_tokens: 7,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("skips the metric when a turn produced zero new tokens", () => {
    const mapper = new SdkRunEventMapper(RUN_ID, fixedNow);
    const events = map(mapper, {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "x" }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    expect(events.some((e) => e.type === "appstrate.metric")).toBe(false);
  });

  it("surfaces a per-turn assistant error as a breadcrumb without deciding status", () => {
    const mapper = new SdkRunEventMapper(RUN_ID, fixedNow);
    const events = map(mapper, {
      type: "assistant",
      message: { content: [] },
      error: { message: "transient overload" },
    });
    expect(events).toEqual([
      {
        type: "appstrate.error",
        timestamp: fixedNow(),
        runId: RUN_ID,
        message: "transient overload",
      },
    ]);
    expect(mapper.terminal()).toBeNull();
  });
});

describe("SdkRunEventMapper — tool results (user messages)", () => {
  it("maps a tool_result to a progress event with truncated content", () => {
    const mapper = new SdkRunEventMapper(RUN_ID, fixedNow);
    const events = map(mapper, {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }],
      },
    });
    expect(events).toEqual([
      {
        type: "appstrate.progress",
        timestamp: fixedNow(),
        runId: RUN_ID,
        message: "Tool result",
        level: "info",
        data: { result: "ok", isError: false, toolCallId: "t1" },
      },
    ]);
  });

  it("flags tool errors", () => {
    const mapper = new SdkRunEventMapper(RUN_ID, fixedNow);
    const events = map(mapper, {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true }],
      },
    }) as Array<Record<string, unknown>>;
    expect(events[0]!.message).toBe("Tool error");
    expect(events[0]!.level).toBe("warn");
    expect(events[0]!.data).toMatchObject({ isError: true, toolCallId: "t2" });
  });
});

describe("SdkRunEventMapper — terminal result", () => {
  it("captures a success verdict with authoritative usage, cost, duration, output", () => {
    const mapper = new SdkRunEventMapper(RUN_ID, fixedNow);
    const events = map(mapper, {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.0123,
      duration_ms: 4200,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
      structured_output: { answer: 42 },
    });
    // Final authoritative metric.
    expect(events).toEqual([
      {
        type: "appstrate.metric",
        timestamp: fixedNow(),
        runId: RUN_ID,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 20,
        },
        cost: 0.0123,
      },
    ]);
    expect(mapper.terminal()).toEqual({
      status: "success",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 20,
      },
      cost: 0.0123,
      durationMs: 4200,
      structuredOutput: { answer: 42 },
    });
  });

  it("maps error subtypes to a failed verdict with a stable code", () => {
    const cases: Array<[string, string]> = [
      ["error_max_turns", "max_turns"],
      ["error_max_budget_usd", "max_budget"],
      ["error_max_structured_output_retries", "output_schema_unsatisfied"],
      ["error_during_execution", "adapter_error"],
    ];
    for (const [subtype, code] of cases) {
      const mapper = new SdkRunEventMapper(RUN_ID, fixedNow);
      map(mapper, { type: "result", subtype, is_error: true, errors: ["nope"], usage: {} });
      const terminal = mapper.terminal();
      expect(terminal?.status).toBe("failed");
      expect(terminal?.error?.code).toBe(code);
      expect(terminal?.error?.message).toBe("nope");
    }
  });

  it("treats is_error:true as failed even when subtype says success", () => {
    const mapper = new SdkRunEventMapper(RUN_ID, fixedNow);
    map(mapper, { type: "result", subtype: "success", is_error: true, usage: {} });
    expect(mapper.terminal()?.status).toBe("failed");
  });

  it("falls back to a generic message when no error text is present", () => {
    const mapper = new SdkRunEventMapper(RUN_ID, fixedNow);
    map(mapper, { type: "result", subtype: "error_during_execution", is_error: true, usage: {} });
    expect(mapper.terminal()?.error?.message).toMatch(/ended in an error/);
  });
});

describe("truncateToolResult", () => {
  it("passes through small payloads untouched", () => {
    expect(truncateToolResult("short")).toBe("short");
    expect(truncateToolResult({ a: 1 })).toEqual({ a: 1 });
    expect(truncateToolResult(null)).toBeNull();
  });

  it("truncates oversized strings on a UTF-8 boundary with a marker", () => {
    const big = "x".repeat(5000);
    const out = truncateToolResult(big) as string;
    expect(out.length).toBeLessThan(big.length);
    expect(out).toMatch(/truncated, 5000 bytes/);
  });

  it("returns a structured marker for oversized objects", () => {
    const out = truncateToolResult({ blob: "y".repeat(5000) }) as Record<string, unknown>;
    expect(out.__truncated).toBe(true);
    expect(out.reason).toBe("size");
  });
});
