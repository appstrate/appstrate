// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { PiChatUiStreamMapper, stripMcpToolPrefix } from "../src/pi-chat/ui-stream-mapper.ts";
import type { AgentSessionEvent } from "../src/pi-chat/pi-events.ts";

/** Feed a list of pi session events through one mapper, collect all UI chunks. */
function run(events: AgentSessionEvent[]) {
  const mapper = new PiChatUiStreamMapper();
  const chunks = events.flatMap((e) => mapper.map(e));
  return { chunks, mapper };
}

describe("stripMcpToolPrefix", () => {
  it("strips the mcp__<server>__ prefix but keeps inner __", () => {
    expect(stripMcpToolPrefix("mcp__platform__search_operations")).toBe("search_operations");
    expect(stripMcpToolPrefix("mcp__platform__run__and__wait")).toBe("run__and__wait");
  });
  it("passes non-MCP names through", () => {
    expect(stripMcpToolPrefix("output")).toBe("output");
  });
});

describe("PiChatUiStreamMapper", () => {
  it("maps a text turn to start-step → text-start/delta/end → finish-step", () => {
    const { chunks } = run([
      { type: "message_start", message: {} },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: {} },
      },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel", partial: {} },
      },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "lo",
          partial: {},
        },
      },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "Hello",
          partial: {},
        },
      },
      { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
    ]);

    expect(chunks).toEqual([
      { type: "start-step" },
      { type: "text-start", id: "1-0" },
      { type: "text-delta", id: "1-0", delta: "Hel" },
      { type: "text-delta", id: "1-0", delta: "lo" },
      { type: "text-end", id: "1-0" },
      { type: "finish-step" },
    ]);
  });

  it("maps a tool call: input-start/available then output-available", () => {
    const { chunks } = run([
      { type: "message_start", message: {} },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 0,
          partial: {
            content: [{ type: "toolCall", id: "call_1", name: "mcp__platform__search_operations" }],
          },
        },
      },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: {
            id: "call_1",
            name: "mcp__platform__search_operations",
            arguments: { q: "x" },
          },
          partial: {},
        },
      },
      {
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "mcp__platform__search_operations",
        result: { content: [{ type: "text", text: "ok" }] },
        isError: false,
      },
    ]);

    expect(chunks).toContainEqual({
      type: "tool-input-start",
      toolCallId: "call_1",
      toolName: "search_operations",
    });
    expect(chunks).toContainEqual({
      type: "tool-input-available",
      toolCallId: "call_1",
      toolName: "search_operations",
      input: { q: "x" },
    });
    expect(chunks).toContainEqual({
      type: "tool-output-available",
      toolCallId: "call_1",
      output: { content: [{ type: "text", text: "ok" }] },
    });
  });

  it("emits tool-output-error for a failed tool execution", () => {
    const { chunks } = run([
      {
        type: "tool_execution_end",
        toolCallId: "call_2",
        toolName: "invoke_operation",
        result: { content: [{ type: "text", text: "boom" }] },
        isError: true,
      },
    ]);
    expect(chunks).toEqual([
      { type: "tool-output-error", toolCallId: "call_2", errorText: "boom" },
    ]);
  });

  it("accumulates usage + cost and reports the finish reason", () => {
    const { mapper } = run([
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          usage: {
            input: 100,
            output: 50,
            cacheRead: 10,
            cacheWrite: 5,
            totalTokens: 165,
            cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
          },
        },
      },
    ]);
    const meta = mapper.result();
    expect(meta.usage.input).toBe(100);
    expect(meta.usage.output).toBe(50);
    expect(meta.costUsd).toBeCloseTo(0.3, 6);
    expect(meta.finishReason).toBe("tool-calls");
  });

  it("captures a terminal error turn's message + error finish reason", () => {
    const { mapper } = run([
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "upstream 500" },
      },
    ]);
    const meta = mapper.result();
    expect(meta.finishReason).toBe("error");
    expect(meta.errorText).toBe("upstream 500");
  });

  it("maps thinking deltas to reasoning-* chunks", () => {
    const { chunks } = run([
      { type: "message_start", message: {} },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: {} },
      },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "hmm",
          partial: {},
        },
      },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: {
          type: "thinking_end",
          contentIndex: 0,
          content: "hmm",
          partial: {},
        },
      },
    ]);
    expect(chunks).toContainEqual({ type: "reasoning-start", id: "1-0" });
    expect(chunks).toContainEqual({ type: "reasoning-delta", id: "1-0", delta: "hmm" });
    expect(chunks).toContainEqual({ type: "reasoning-end", id: "1-0" });
  });

  it("ignores unknown session events (forward-compat catch-all)", () => {
    const { chunks } = run([{ type: "queue_update", steering: [], followUp: [] }]);
    expect(chunks).toEqual([]);
  });
});
