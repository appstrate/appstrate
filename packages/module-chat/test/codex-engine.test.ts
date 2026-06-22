// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { CodexUiStreamMapper } from "../src/codex-agent/ui-stream-mapper.ts";
import { buildCodexPrompt } from "../src/codex-agent/engine.ts";
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

  // Real shapes captured from `codex exec --json` calling the platform MCP.
  it("maps an mcp_tool_call (start → completed) to tool-input/-output chunks", () => {
    const m = new CodexUiStreamMapper();
    expect(
      m.map({
        type: "item.started",
        item: {
          id: "item_1",
          type: "mcp_tool_call",
          server: "platform",
          tool: "search_operations",
          arguments: { query: "agents", limit: 10 },
          status: "in_progress",
        },
      }),
    ).toEqual([
      { type: "tool-input-start", toolCallId: "item_1", toolName: "search_operations" },
      {
        type: "tool-input-available",
        toolCallId: "item_1",
        toolName: "search_operations",
        input: { query: "agents", limit: 10 },
      },
    ]);
    expect(
      m.map({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "mcp_tool_call",
          tool: "search_operations",
          result: { content: [{ type: "text", text: "{...}" }] },
          status: "completed",
        },
      }),
    ).toEqual([
      {
        type: "tool-output-available",
        toolCallId: "item_1",
        output: { content: [{ type: "text", text: "{...}" }] },
      },
    ]);
  });

  it("maps a failed/cancelled mcp_tool_call to tool-output-error", () => {
    const m = new CodexUiStreamMapper();
    expect(
      m.map({
        type: "item.completed",
        item: {
          id: "item_4",
          type: "mcp_tool_call",
          tool: "invoke_operation",
          result: null,
          error: { message: "user cancelled MCP tool call" },
          status: "failed",
        },
      }),
    ).toEqual([
      {
        type: "tool-output-error",
        toolCallId: "item_4",
        errorText: "user cancelled MCP tool call",
      },
    ]);
  });
});

describe("buildCodexPrompt", () => {
  const mk = (role: "user" | "assistant", text: string): UIMessage =>
    ({ id: role, role, parts: [{ type: "text", text }] }) as UIMessage;

  it("a single user turn is sent verbatim under the system prefix", () => {
    const out = buildCodexPrompt([mk("user", "salut")], "SYS");
    expect(out).toBe("SYS\n\n---\n\nsalut");
  });

  it("multiple turns become a labelled transcript", () => {
    const out = buildCodexPrompt([mk("user", "a"), mk("assistant", "b"), mk("user", "c")], "");
    expect(out).toBe("User: a\n\nAssistant: b\n\nUser: c");
  });
});
