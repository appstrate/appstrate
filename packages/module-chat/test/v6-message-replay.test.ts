// SPDX-License-Identifier: Apache-2.0

/**
 * v6 → v7 persisted-message replay guard.
 *
 * Chat persistence stores UIMessage JSON verbatim (`persistence.ts`, format
 * `ai-sdk/v6`); prod holds ~171 sessions written under AI SDK v6. On every turn
 * the load path replays that stored history through `convertToModelMessages`
 * (see `chat-stream.ts`, called with `mcp.tools`), so a shape v7 no longer
 * accepts — or silently drops — would corrupt the model's view of past turns and
 * bypass the connect-link redaction that rides each tool's `toModelOutput`.
 *
 * These tests feed realistic v6-shaped persisted assistant messages (text,
 * reasoning, step-start, a static `tool-<name>` part and a `dynamic-tool` part,
 * both `output-available` with input+output) through v7's
 * `convertToModelMessages` and assert the replay: no throw, correct model-message
 * roles/content, tool results present, and `toModelOutput` invoked on the
 * replayed history (the redaction path).
 */

import { describe, it, expect, mock } from "bun:test";
import { convertToModelMessages, type UIMessage } from "ai";
import { wrapToolModelOutputs } from "../src/platform-mcp.ts";

const PLACEHOLDER = "[connect link hidden — the chat renders the connect card]";

/**
 * A v6-persisted thread: a user turn plus an assistant turn carrying every part
 * kind chat can persist — text, reasoning, a step boundary, a static tool call
 * (`tool-search_operations`) and a dynamic tool call (`dynamic-tool`), each in
 * the completed `output-available` shape (input + output). Ids match the wire
 * shape assistant-ui writes.
 */
function v6Thread(): UIMessage[] {
  return [
    { id: "m_user", role: "user", parts: [{ type: "text", text: "connect gmail" }] },
    {
      id: "m_asst",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "The user wants to connect Gmail." },
        { type: "text", text: "Let me look that up." },
        { type: "step-start" },
        {
          // Static tool part: `type: "tool-<name>"`, completed with input+output.
          type: "tool-search_operations",
          toolCallId: "call_static_1",
          state: "output-available",
          input: { query: "gmail connect" },
          // The connect_url in a completed tool output is what the redacting
          // `toModelOutput` must scrub on replay.
          output: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  connect_url: "https://app/api/integrations/connect/start?token=t",
                }),
              },
            ],
          },
        } as never,
        {
          // Dynamic tool part: `type: "dynamic-tool"`, name carried on `toolName`.
          type: "dynamic-tool",
          toolName: "invoke_operation",
          toolCallId: "call_dynamic_1",
          state: "output-available",
          input: { operationId: "connectGmail" },
          output: { content: [{ type: "text", text: JSON.stringify({ status: "ok" }) }] },
        } as never,
      ],
    },
  ];
}

/**
 * A tools record shaped like `openPlatformMcp` hands to `streamText` /
 * `convertToModelMessages`: each MCP tool carries a `toModelOutput` mirroring the
 * client's `mcpToModelOutput` (raw result → `{type:"content"}`), wrapped by the
 * production `wrapToolModelOutputs` so the connect-link redaction is exercised.
 * The spies record that `toModelOutput` ran on replay.
 */
function toolsWithRedactingModelOutput() {
  const staticSpy = mock((args: { output: unknown }) => mcpLikeModelOutput(args.output));
  const dynamicSpy = mock((args: { output: unknown }) => mcpLikeModelOutput(args.output));
  const base = {
    search_operations: { description: "search", execute: () => ({}), toModelOutput: staticSpy },
    invoke_operation: { description: "invoke", execute: () => ({}), toModelOutput: dynamicSpy },
  };
  const tools = wrapToolModelOutputs(base as never);
  return { tools, staticSpy, dynamicSpy };
}

/** Mimic `@ai-sdk/mcp`'s `mcpToModelOutput`: a CallToolResult → `{type:"content"}`. */
function mcpLikeModelOutput(output: unknown): {
  type: "content";
  value: Array<{ type: "text"; text: string }>;
} {
  const content = (output as { content?: Array<{ type?: string; text?: string }> })?.content ?? [];
  return {
    type: "content",
    value: content
      .filter((p) => p?.type === "text")
      .map((p) => ({ type: "text", text: String(p.text ?? "") })),
  };
}

/** Flatten the content parts of every assistant model message. */
function assistantContent(
  messages: Awaited<ReturnType<typeof convertToModelMessages>>,
): Array<{ type: string; text?: string; toolName?: string }> {
  return messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content as Array<{ type: string; text?: string; toolName?: string }>);
}

describe("v6 message replay through convertToModelMessages (v7)", () => {
  it("replays a v6 thread without throwing and yields the expected role sequence", async () => {
    const { tools } = toolsWithRedactingModelOutput();
    const modelMessages = await convertToModelMessages(v6Thread(), { tools: tools as never });

    // The `step-start` part partitions the assistant turn into two model
    // messages (reasoning+text before it, tool-calls after), followed by the tool
    // message carrying the results — semantically faithful to the persisted turn.
    expect(modelMessages.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "tool"]);
  });

  it("preserves the assistant text, reasoning, and both tool calls on replay", async () => {
    const { tools } = toolsWithRedactingModelOutput();
    const content = assistantContent(
      await convertToModelMessages(v6Thread(), { tools: tools as never }),
    );
    expect(content.find((c) => c.type === "text")?.text).toBe("Let me look that up.");
    expect(content.find((c) => c.type === "reasoning")?.text).toBe(
      "The user wants to connect Gmail.",
    );
    // Both tool calls (static + dynamic) survive the replay.
    const toolCalls = content.filter((c) => c.type === "tool-call");
    expect(toolCalls.map((c) => c.toolName).sort()).toEqual([
      "invoke_operation",
      "search_operations",
    ]);
  });

  it("carries both tool results into the tool message with toModelOutput redacting on replay", async () => {
    const { tools, staticSpy, dynamicSpy } = toolsWithRedactingModelOutput();
    const messages = await convertToModelMessages(v6Thread(), { tools: tools as never });
    const toolMessage = messages.find((m) => m.role === "tool");
    const results = toolMessage!.content as Array<{
      type: string;
      toolCallId: string;
      toolName: string;
      output: { type: string; value: Array<{ type: string; text: string }> };
    }>;

    // Both tool calls produced results, chained onto the right call ids.
    expect(results.map((r) => r.toolCallId).sort()).toEqual(["call_dynamic_1", "call_static_1"]);

    // toModelOutput ran on the replayed history (the redaction path), not just the
    // live turn — once per replayed tool result.
    expect(staticSpy).toHaveBeenCalledTimes(1);
    expect(dynamicSpy).toHaveBeenCalledTimes(1);

    // The connect_url that was persisted in the static tool's output is redacted
    // on replay — the model never re-sees a link it should not paste.
    const staticResult = results.find((r) => r.toolCallId === "call_static_1")!;
    const parsed = JSON.parse(staticResult.output.value[0]!.text) as {
      ok: boolean;
      connect_url: string;
    };
    expect(parsed.connect_url).toBe(PLACEHOLDER);
    expect(parsed.ok).toBe(true);
  });

  it("does not throw when the tools record is absent (history-only replay)", async () => {
    // The load path passes `tools: undefined` when the mcp module is not wired;
    // replay must still succeed (default JSON model-output, no redaction wrapper).
    const messages = await convertToModelMessages(v6Thread(), { tools: undefined });
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "tool"]);
  });
});
