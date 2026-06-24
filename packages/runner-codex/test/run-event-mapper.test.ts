// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { CodexRunEventMapper, computeCodexCost } from "../src/run-event-mapper.ts";

const FIXED = 1_700_000_000_000;
const now = () => FIXED;

describe("CodexRunEventMapper.map", () => {
  it("maps an agent_message item to a progress event", () => {
    const m = new CodexRunEventMapper("run_1", now);
    const events = m.map({
      type: "item.completed",
      item: { type: "agent_message", text: "  hi  " },
    });
    expect(events).toEqual([
      { type: "appstrate.progress", timestamp: FIXED, runId: "run_1", message: "hi" },
    ]);
  });

  it("tags reasoning items so the UI can style them", () => {
    const m = new CodexRunEventMapper("run_1", now);
    const events = m.map({ type: "item.completed", item: { type: "reasoning", text: "thinking" } });
    expect(events[0]).toMatchObject({ type: "appstrate.progress", data: { reasoning: true } });
  });

  it("maps a command_execution item to a shell breadcrumb", () => {
    const m = new CodexRunEventMapper("run_1", now);
    const events = m.map({
      type: "item.completed",
      item: { type: "command_execution", command: "ls -la" },
    });
    expect(events[0]).toMatchObject({
      message: "Shell: ls -la",
      data: { tool: "shell", command: "ls -la" },
    });
  });

  it("maps an mcp_tool_call to a server-qualified tool breadcrumb", () => {
    const m = new CodexRunEventMapper("run_1", now);
    const events = m.map({
      type: "item.completed",
      item: { type: "mcp_tool_call", server: "platform", tool: "api_call" },
    });
    // Reads item.server/item.tool (NOT the nonexistent item.name) so the run
    // timeline can attribute which platform tool the agent invoked.
    expect(events[0]).toMatchObject({
      message: "Tool: platform__api_call",
      data: { tool: "platform__api_call" },
    });
  });

  it("falls back gracefully when an mcp_tool_call carries no tool name", () => {
    const m = new CodexRunEventMapper("run_1", now);
    const events = m.map({ type: "item.completed", item: { type: "mcp_tool_call" } });
    expect(events[0]).toMatchObject({ message: "Tool: mcp tool", data: { tool: "mcp tool" } });
  });

  it("ignores framing and unknown item types", () => {
    const m = new CodexRunEventMapper("run_1", now);
    expect(m.map({ type: "thread.started", thread_id: "t1" })).toEqual([]);
    expect(m.map({ type: "turn.started" })).toEqual([]);
    expect(m.map({ type: "item.completed", item: { type: "todo_list", text: "x" } })).toEqual([]);
  });

  it("captures cumulative usage on turn.completed and emits a metric", () => {
    const m = new CodexRunEventMapper("run_1", now);
    const events = m.map({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 50,
        reasoning_output_tokens: 10,
      },
    });
    expect(events[0]).toMatchObject({
      type: "appstrate.metric",
      usage: {
        input_tokens: 100,
        output_tokens: 50, // reasoning is already folded into output_tokens — not double-counted
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 0,
      },
    });
    expect(m.usage()).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 0,
    });
    expect(m.failure()).toBeNull();
  });

  it("records a failure on turn.failed and emits an error event", () => {
    const m = new CodexRunEventMapper("run_1", now);
    const events = m.map({ type: "turn.failed", error: { message: "rate limited" } });
    expect(events[0]).toEqual({
      type: "appstrate.error",
      timestamp: FIXED,
      runId: "run_1",
      message: "rate limited",
    });
    expect(m.failure()).toEqual({ code: "adapter_error", message: "rate limited" });
  });

  it("records a failure on a bare error event with a string error", () => {
    const m = new CodexRunEventMapper("run_1", now);
    m.map({ type: "error", error: "boom" });
    expect(m.failure()?.message).toBe("boom");
  });
});

describe("computeCodexCost", () => {
  it("is zero when no cost rates are supplied", () => {
    expect(
      computeCodexCost(
        {
          input_tokens: 1000,
          output_tokens: 1000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        null,
      ),
    ).toBe(0);
  });

  it("computes Σ(tokens × rate / 1e6) across input/output/cache", () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 2_000_000,
      cache_read_input_tokens: 500_000,
      cache_creation_input_tokens: 0,
    };
    const cost = computeCodexCost(usage, { input: 1, output: 2, cacheRead: 0.5 });
    // 1*1 + 2*2 + 0.5*0.5 = 1 + 4 + 0.25
    expect(cost).toBeCloseTo(5.25, 6);
  });
});
