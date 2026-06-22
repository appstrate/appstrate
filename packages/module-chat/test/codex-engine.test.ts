// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { CodexUiStreamMapper } from "../src/codex-agent/ui-stream-mapper.ts";
import { buildTranscriptPrompt } from "../src/transcript.ts";
import type { UIMessage } from "ai";

describe("CodexUiStreamMapper", () => {
  it("maps a turn to start-step → text block → finish-step with usage", () => {
    const m = new CodexUiStreamMapper();
    expect(m.map({ type: "thread.started", thread_id: "t1" })).toEqual([]);
    expect(m.map({ type: "turn.started" })).toEqual([{ type: "start-step" }]);
    expect(
      m.map({ type: "item.completed", item: { id: "i0", type: "agent_message", text: "hello" } }),
    ).toEqual([
      { type: "text-start", id: "i0" },
      { type: "text-delta", id: "i0", delta: "hello" },
      { type: "text-end", id: "i0" },
    ]);
    expect(
      m.map({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
    ).toEqual([{ type: "finish-step" }]);
    const finish = m.finishChunk();
    expect(finish.type).toBe("finish");
    expect(m.resultMeta()?.usage?.output_tokens).toBe(5);
  });

  it("maps a reasoning item to a reasoning block", () => {
    const m = new CodexUiStreamMapper();
    expect(
      m.map({ type: "item.completed", item: { id: "r0", type: "reasoning", text: "thinking" } }),
    ).toEqual([
      { type: "reasoning-start", id: "r0" },
      { type: "reasoning-delta", id: "r0", delta: "thinking" },
      { type: "reasoning-end", id: "r0" },
    ]);
  });

  it("skips codex coding-sandbox items (command_execution etc.)", () => {
    const m = new CodexUiStreamMapper();
    expect(
      m.map({ type: "item.completed", item: { id: "c0", type: "command_execution", text: "ls" } }),
    ).toEqual([]);
  });

  it("surfaces a turn.failed as an error chunk + error meta", () => {
    const m = new CodexUiStreamMapper();
    const out = m.map({ type: "turn.failed", error: { message: "boom" } });
    expect(out).toEqual([{ type: "error", errorText: "boom" }]);
    expect(m.resultMeta()?.isError).toBe(true);
    expect(m.finishChunk().finishReason).toBe("error");
  });

  it("maps an mcp_tool_call: input on item.started, output on item.completed", () => {
    const m = new CodexUiStreamMapper();
    expect(
      m.map({
        type: "item.started",
        item: {
          id: "t0",
          type: "mcp_tool_call",
          server: "platform",
          tool: "search_operations",
          arguments: { query: "run agent" },
          status: "in_progress",
        },
      }),
    ).toEqual([
      {
        type: "tool-input-available",
        toolCallId: "t0",
        toolName: "search_operations",
        input: { query: "run agent" },
      },
    ]);
    expect(
      m.map({
        type: "item.completed",
        item: {
          id: "t0",
          type: "mcp_tool_call",
          server: "platform",
          tool: "search_operations",
          status: "completed",
          result: { content: [{ type: "text", text: "{}" }], structured_content: { count: 3 } },
        },
      }),
    ).toEqual([{ type: "tool-output-available", toolCallId: "t0", output: { count: 3 } }]);
  });

  it("emits input before output when item.started was missed", () => {
    const m = new CodexUiStreamMapper();
    const out = m.map({
      type: "item.completed",
      item: {
        id: "t1",
        type: "mcp_tool_call",
        tool: "render_html",
        arguments: { code: "<h1/>" },
        status: "completed",
        result: { content: [{ type: "text", text: '{"rendered":true}' }] },
      },
    });
    expect(out).toEqual([
      {
        type: "tool-input-available",
        toolCallId: "t1",
        toolName: "render_html",
        input: { code: "<h1/>" },
      },
      {
        type: "tool-output-available",
        toolCallId: "t1",
        output: [{ type: "text", text: '{"rendered":true}' }],
      },
    ]);
  });

  it("maps a failed mcp_tool_call to tool-output-error", () => {
    const m = new CodexUiStreamMapper();
    m.map({
      type: "item.started",
      item: {
        id: "t2",
        type: "mcp_tool_call",
        tool: "invoke_operation",
        arguments: {},
        status: "in_progress",
      },
    });
    const out = m.map({
      type: "item.completed",
      item: {
        id: "t2",
        type: "mcp_tool_call",
        tool: "invoke_operation",
        status: "failed",
        error: { message: "403" },
      },
    });
    expect(out).toEqual([{ type: "tool-output-error", toolCallId: "t2", errorText: "403" }]);
  });
});

describe("buildTranscriptPrompt (codex system prefix)", () => {
  const mk = (role: "user" | "assistant", text: string): UIMessage =>
    ({ id: role, role, parts: [{ type: "text", text }] }) as UIMessage;

  it("a single user turn is sent verbatim under the system prefix", () => {
    const out = buildTranscriptPrompt([mk("user", "salut")], { system: "SYS" });
    expect(out).toBe("SYS\n\n---\n\nsalut");
  });

  it("multiple turns become a labelled transcript", () => {
    const out = buildTranscriptPrompt([mk("user", "a"), mk("assistant", "b"), mk("user", "c")], {
      system: "",
    });
    expect(out).toBe("User: a\n\nAssistant: b\n\nUser: c");
  });
});
