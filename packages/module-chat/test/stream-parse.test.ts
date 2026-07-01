// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { extractAssistantMessage } from "../src/stream-parse.ts";

/**
 * The server persists the assistant turn by parsing a teed copy of the engine's
 * AI SDK UI-message stream (SSE bytes). These tests feed a real encoded stream
 * through the parser and assert the assembled assistant message — the data that
 * gets written to chat_messages when the stream finalizes.
 */
describe("extractAssistantMessage", () => {
  function encode(
    execute: Parameters<typeof createUIMessageStream>[0]["execute"],
  ): ReadableStream<Uint8Array> {
    const stream = createUIMessageStream({ execute });
    return createUIMessageStreamResponse({ stream }).body!;
  }

  it("assembles the final assistant message from a UI-message SSE stream", async () => {
    const body = encode(async ({ writer }) => {
      writer.write({ type: "start", messageId: "asst_1" });
      writer.write({ type: "text-start", id: "t1" });
      writer.write({ type: "text-delta", id: "t1", delta: "Hello" });
      writer.write({ type: "text-delta", id: "t1", delta: " world" });
      writer.write({ type: "text-end", id: "t1" });
      writer.write({ type: "finish" });
    });

    const message = await extractAssistantMessage(body);
    expect(message?.role).toBe("assistant");
    expect(message?.id).toBe("asst_1");
    const text = (message?.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(text).toBe("Hello world");
  });

  it("returns undefined for an empty stream", async () => {
    const body = encode(async () => {});
    expect(await extractAssistantMessage(body)).toBeUndefined();
  });

  it("drains a multi-event stream to completion (the disconnect-proof read)", async () => {
    const body = encode(async ({ writer }) => {
      writer.write({ type: "start", messageId: "asst_2" });
      writer.write({ type: "text-start", id: "a" });
      writer.write({ type: "text-delta", id: "a", delta: "one" });
      writer.write({ type: "text-end", id: "a" });
      writer.write({ type: "finish" });
    });
    const message = await extractAssistantMessage(body);
    expect(message?.id).toBe("asst_2");
  });

  it("preserves finish message metadata on the persisted assistant message", async () => {
    const body = encode(async ({ writer }) => {
      writer.write({ type: "start", messageId: "asst_meta" });
      writer.write({ type: "text-start", id: "t" });
      writer.write({ type: "text-delta", id: "t", delta: "partial" });
      writer.write({ type: "text-end", id: "t" });
      writer.write({
        type: "finish",
        messageMetadata: {
          appstrate: {
            turn: {
              engine: "ai-sdk",
              stepCount: 16,
              maxSteps: 16,
              maxStepsReached: true,
            },
          },
        },
      });
    });

    const message = await extractAssistantMessage(body);
    expect((message as { metadata?: unknown } | undefined)?.metadata).toEqual({
      appstrate: {
        turn: {
          engine: "ai-sdk",
          stepCount: 16,
          maxSteps: 16,
          maxStepsReached: true,
        },
      },
    });
  });
});
