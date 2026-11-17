// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessageChunk } from "ai";
import { PiChatUiStreamMapper } from "../src/pi-chat/ui-stream-mapper.ts";
import { dispatchSpace } from "../src/pi-chat/mcp-tools.ts";
import { extractAssistantMessage } from "../src/stream-parse.ts";
import type { AgentSessionEvent } from "../src/pi-chat/pi-events.ts";
import { callSpaceOf } from "../src/ui/conversation-scope.ts";

/**
 * The per-call space stamp must survive the whole server path: the mapper's chunk, the SSE wire,
 * and the AI SDK's assembly of the assistant message that is persisted. The SDK keeps a call's
 * `providerMetadata` on the stored tool part as `callProviderMetadata`.
 */
function callEnd(args: Record<string, unknown>): AgentSessionEvent[] {
  return [
    { type: "message_start", message: {} },
    {
      type: "message_update",
      message: {},
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { id: "call_1", name: "mcp__platform__invoke_operation", arguments: args },
        partial: {},
      },
    } as AgentSessionEvent,
  ];
}

/** Run one call through mapper → SSE → persisted-message assembly; the stored tool part. */
async function persistedToolPart(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const mapper = new PiChatUiStreamMapper({ callSpace: dispatchSpace });
  const chunks: UIMessageChunk[] = [
    { type: "start", messageId: "asst_1" },
    ...callEnd(args).flatMap((e) => mapper.map(e)),
    { type: "tool-output-available", toolCallId: "call_1", output: { ok: true } },
    { type: "finish" },
  ];
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      for (const chunk of chunks) writer.write(chunk);
    },
  });
  const message = await extractAssistantMessage(createUIMessageStreamResponse({ stream }).body!);
  const part = message?.parts.find((p) => p.type === "tool-invoke_operation");
  expect(part).toBeDefined();
  return part as Record<string, unknown>;
}

describe("a finalized assistant message keeps each call's space", () => {
  it("stamps a call with the space it names", async () => {
    const part = await persistedToolPart({ operation_id: "listRuns", space_id: "spc_named" });
    expect(part.state).toBe("output-available");
    expect(part.callProviderMetadata).toEqual({ appstrate: { spaceId: "spc_named" } });
  });

  it("is what the card reads back, live and after reload", async () => {
    const part = await persistedToolPart({ operation_id: "listRuns", space_id: "spc_named" });
    // The runtime hands the card the stored `callProviderMetadata` as `providerMetadata`.
    expect(callSpaceOf({ providerMetadata: part.callProviderMetadata })).toBe("spc_named");
  });
});
