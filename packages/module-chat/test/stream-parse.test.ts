// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, mock } from "bun:test";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { extractAssistantMessage } from "../src/stream-parse.ts";
import { logger } from "../src/logger.ts";

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

    const message = await extractAssistantMessage(body);
    expect(message?.role).toBe("assistant");
    expect(message?.id).toBe("asst_1");
    expect(textOf(message!)).toBe("Hello world");
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
      const message = await extractAssistantMessage(corrupted);
      expect(message?.id).toBe("asst_ok");
      expect(textOf(message!)).toBe("ok");
      // Two malformed frames, but the log fires only once per stream.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toBe("chat sse frame parse failed");
    } finally {
      logger.error = original;
    }
  });
});
