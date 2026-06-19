// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  SdkUiStreamMapper,
  normalizeToolName,
  type ClaudeSdkMessage,
} from "../src/claude-agent/ui-stream-mapper.ts";
import type { UIMessageChunk } from "ai";

/** Run a sequence of SDK messages through a fresh mapper, collecting chunks. */
function run(messages: ClaudeSdkMessage[]): UIMessageChunk[] {
  const mapper = new SdkUiStreamMapper();
  return messages.flatMap((m) => mapper.map(m));
}

const ev = (event: Record<string, unknown>): ClaudeSdkMessage =>
  ({ type: "stream_event", event }) as ClaudeSdkMessage;

describe("normalizeToolName", () => {
  test("strips the mcp__<server>__ prefix", () => {
    expect(normalizeToolName("mcp__platform__search_operations")).toBe("search_operations");
    expect(normalizeToolName("mcp__appstrate_local__render_html")).toBe("render_html");
  });
  test("preserves tool names that themselves contain __", () => {
    expect(normalizeToolName("mcp__platform__a__b")).toBe("a__b");
  });
  test("passes through non-mcp names", () => {
    expect(normalizeToolName("wait_for_run")).toBe("wait_for_run");
  });
});

describe("SdkUiStreamMapper — text turn", () => {
  test("maps a streamed text turn to start-step → text-* → finish-step", () => {
    const chunks = run([
      ev({ type: "message_start" }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Bon" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "jour" } }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "message_stop" }),
    ]);
    expect(chunks).toEqual([
      { type: "start-step" },
      { type: "text-start", id: "1-0" },
      { type: "text-delta", id: "1-0", delta: "Bon" },
      { type: "text-delta", id: "1-0", delta: "jour" },
      { type: "text-end", id: "1-0" },
      { type: "finish-step" },
    ]);
  });
});

describe("SdkUiStreamMapper — tool call + result", () => {
  test("streams tool input then maps the tool_result to tool-output-available", () => {
    const chunks = run([
      ev({ type: "message_start" }),
      ev({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_1",
          name: "mcp__appstrate_local__render_html",
        },
      }),
      ev({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"code":' },
      }),
      ev({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"<h1>hi</h1>"}' },
      }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "message_stop" }),
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "ok" }],
            },
          ],
        },
      } as ClaudeSdkMessage,
    ]);

    expect(chunks).toEqual([
      { type: "start-step" },
      // tool name is normalized — the client tool UI keys on `render_html`.
      { type: "tool-input-start", toolCallId: "toolu_1", toolName: "render_html" },
      { type: "tool-input-delta", toolCallId: "toolu_1", inputTextDelta: '{"code":' },
      { type: "tool-input-delta", toolCallId: "toolu_1", inputTextDelta: '"<h1>hi</h1>"}' },
      {
        type: "tool-input-available",
        toolCallId: "toolu_1",
        toolName: "render_html",
        input: { code: "<h1>hi</h1>" },
      },
      { type: "finish-step" },
      {
        type: "tool-output-available",
        toolCallId: "toolu_1",
        output: [{ type: "text", text: "ok" }],
      },
    ]);
  });

  test("maps an errored tool_result to tool-output-error", () => {
    const chunks = run([
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_x", is_error: true, content: "boom" },
          ],
        },
      } as ClaudeSdkMessage,
    ]);
    expect(chunks).toEqual([
      { type: "tool-output-error", toolCallId: "toolu_x", errorText: "boom" },
    ]);
  });

  test("tolerates malformed tool input JSON (falls back to {})", () => {
    const chunks = run([
      ev({ type: "message_start" }),
      ev({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t", name: "x" },
      }),
      ev({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{bad" },
      }),
      ev({ type: "content_block_stop", index: 0 }),
    ]);
    const available = chunks.find((c) => c.type === "tool-input-available");
    expect(available).toMatchObject({ toolCallId: "t", toolName: "x", input: {} });
  });
});

describe("SdkUiStreamMapper — reasoning", () => {
  test("maps thinking blocks to reasoning-* chunks", () => {
    const chunks = run([
      ev({ type: "message_start" }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      ev({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "hmm" },
      }),
      ev({ type: "content_block_stop", index: 0 }),
    ]);
    expect(chunks).toEqual([
      { type: "start-step" },
      { type: "reasoning-start", id: "1-0" },
      { type: "reasoning-delta", id: "1-0", delta: "hmm" },
      { type: "reasoning-end", id: "1-0" },
    ]);
  });
});

describe("SdkUiStreamMapper — multi-step block ids", () => {
  test("namespaces block ids per step so they never collide across turns", () => {
    const chunks = run([
      ev({ type: "message_start" }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "message_stop" }),
      ev({ type: "message_start" }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "message_stop" }),
    ]);
    const starts = chunks
      .filter((c) => c.type === "text-start")
      .map((c) => (c as { id: string }).id);
    expect(starts).toEqual(["1-0", "2-0"]);
  });
});

describe("SdkUiStreamMapper — terminal metadata", () => {
  test("captures success usage/cost and a stop finishReason", () => {
    const mapper = new SdkUiStreamMapper();
    mapper.map({
      type: "result",
      subtype: "success",
      is_error: false,
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 3 },
      total_cost_usd: 0.0012,
    } as ClaudeSdkMessage);
    expect(mapper.resultMeta()).toMatchObject({ isError: false, finishReason: "stop" });
    expect(mapper.finishChunk()).toEqual({
      type: "finish",
      finishReason: "stop",
      messageMetadata: { usage: { input_tokens: 10, output_tokens: 3 }, costUsd: 0.0012 },
    });
  });

  test("max_tokens stop maps to finishReason length", () => {
    const mapper = new SdkUiStreamMapper();
    mapper.map({
      type: "result",
      subtype: "success",
      stop_reason: "max_tokens",
    } as ClaudeSdkMessage);
    expect(mapper.finishChunk().type).toBe("finish");
    expect((mapper.finishChunk() as { finishReason: string }).finishReason).toBe("length");
  });

  test("error result is flagged and finishes with finishReason error", () => {
    const mapper = new SdkUiStreamMapper();
    mapper.map({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "boom",
    } as ClaudeSdkMessage);
    const meta = mapper.resultMeta();
    expect(meta?.isError).toBe(true);
    expect(meta?.errorText).toBe("boom");
    expect((mapper.finishChunk() as { finishReason: string }).finishReason).toBe("error");
  });

  test("finishChunk defaults to stop when no result was seen", () => {
    const mapper = new SdkUiStreamMapper();
    expect(mapper.finishChunk()).toEqual({
      type: "finish",
      finishReason: "stop",
      messageMetadata: undefined,
    });
  });
});

describe("SdkUiStreamMapper — assistant error", () => {
  test("surfaces an assistant-level auth error as an error chunk", () => {
    const chunks = run([{ type: "assistant", error: "authentication_failed" } as ClaudeSdkMessage]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.type).toBe("error");
    expect((chunks[0] as { errorText: string }).errorText).toMatch(/Authentification/);
  });

  test("a clean assistant message emits nothing (text/tools already streamed)", () => {
    const chunks = run([
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      } as ClaudeSdkMessage,
    ]);
    expect(chunks).toEqual([]);
  });
});

describe("SdkUiStreamMapper — startChunk", () => {
  test("emits a start chunk carrying the message id", () => {
    const mapper = new SdkUiStreamMapper();
    expect(mapper.startChunk("msg_1")).toEqual({ type: "start", messageId: "msg_1" });
  });
});
