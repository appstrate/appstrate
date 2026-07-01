// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, mock } from "bun:test";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { extractAssistantMessages } from "../src/stream-parse.ts";
import { logger } from "../src/logger.ts";

/**
 * The server persists the assistant turn by parsing a teed copy of the engine's
 * AI SDK UI-message stream (SSE bytes). These tests feed a real encoded stream
 * through the parser and assert the assembled assistant messages — the data that
 * gets written to chat_messages when the stream finalizes.
 */
describe("extractAssistantMessages", () => {
  function encode(
    execute: Parameters<typeof createUIMessageStream>[0]["execute"],
  ): ReadableStream<Uint8Array> {
    const stream = createUIMessageStream({ execute });
    return createUIMessageStreamResponse({ stream }).body!;
  }

  function textOf(message: { parts?: { type: string }[] }): string {
    return (message.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
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

    const messages = await extractAssistantMessages(body);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("assistant");
    expect(messages[0]?.id).toBe("asst_1");
    expect(textOf(messages[0]!)).toBe("Hello world");
  });

  it("returns an empty array for an empty stream", async () => {
    const body = encode(async () => {});
    expect(await extractAssistantMessages(body)).toEqual([]);
  });

  it("keeps every message of a multi-message turn, in first-appearance order", async () => {
    const body = encode(async ({ writer }) => {
      writer.write({ type: "start", messageId: "asst_a" });
      writer.write({ type: "text-start", id: "a" });
      writer.write({ type: "text-delta", id: "a", delta: "first" });
      writer.write({ type: "text-end", id: "a" });
      writer.write({ type: "finish" });
      writer.write({ type: "start", messageId: "asst_b" });
      writer.write({ type: "text-start", id: "b" });
      writer.write({ type: "text-delta", id: "b", delta: "second" });
      writer.write({ type: "text-end", id: "b" });
      writer.write({ type: "finish" });
    });

    // The guarantee: when a turn carries more than one message id, EVERY id
    // survives as a distinct entry, in first-appearance order — earlier ones are
    // no longer dropped. ai-sdk v6 `readUIMessageStream` carries parts forward
    // across `start` boundaries within one stream (the later snapshot is
    // cumulative); the extractor strips that carried prefix so each persisted
    // message holds ONLY its own content — no duplication across rows.
    const messages = await extractAssistantMessages(body);
    expect(messages.map((m) => m.id)).toEqual(["asst_a", "asst_b"]);
    expect(textOf(messages[0]!)).toBe("first");
    expect(textOf(messages[1]!)).toBe("second");
  });

  it("drains a multi-event stream to completion (the disconnect-proof read)", async () => {
    const body = encode(async ({ writer }) => {
      writer.write({ type: "start", messageId: "asst_2" });
      writer.write({ type: "text-start", id: "a" });
      writer.write({ type: "text-delta", id: "a", delta: "one" });
      writer.write({ type: "text-end", id: "a" });
      writer.write({ type: "finish" });
    });
    const messages = await extractAssistantMessages(body);
    expect(messages[0]?.id).toBe("asst_2");
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

    const [message] = await extractAssistantMessages(body);
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

  it("still yields the valid messages when a frame is malformed, logging once", async () => {
    // Prepend a corrupt SSE data frame to an otherwise valid stream, then assert
    // parsing recovers (the valid message is assembled) and the failure is logged
    // exactly once — never thrown (a throw would fail the persist drain).
    const valid = encode(async ({ writer }) => {
      writer.write({ type: "start", messageId: "asst_ok" });
      writer.write({ type: "text-start", id: "t" });
      writer.write({ type: "text-delta", id: "t", delta: "ok" });
      writer.write({ type: "text-end", id: "t" });
      writer.write({ type: "finish" });
    });
    const badFrame = new TextEncoder().encode("data: {not json\n\ndata: {also bad\n\n");
    const corrupted = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(badFrame);
        const reader = valid.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      },
    });

    const errorSpy = mock(() => {});
    const original = logger.error;
    logger.error = errorSpy as unknown as typeof logger.error;
    try {
      const messages = await extractAssistantMessages(corrupted);
      expect(messages.map((m) => m.id)).toEqual(["asst_ok"]);
      expect(textOf(messages[0]!)).toBe("ok");
      // Two malformed frames, but the log fires only once per stream.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toBe("chat sse frame parse failed");
    } finally {
      logger.error = original;
    }
  });
});
