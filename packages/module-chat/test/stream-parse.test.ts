// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, mock } from "bun:test";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  readUIMessageStream,
  type UIMessage,
} from "ai";
import { extractAssistantMessage, sseToChunks } from "../src/stream-parse.ts";
import { logger } from "../src/logger.ts";

/**
 * The implementation `extractAssistantMessage` replaced, kept as the baseline
 * the single-pass one is measured against. `readUIMessageStream` re-emits a
 * `structuredClone` of the whole in-progress message on every chunk.
 */
async function legacyExtract(
  byteStream: ReadableStream<Uint8Array>,
): Promise<UIMessage | undefined> {
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream: sseToChunks(byteStream) })) {
    last = message;
  }
  return last?.role === "assistant" ? last : undefined;
}

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

  it("assembles the turn in ONE pass — no per-chunk clone of the growing message", async () => {
    // The hazard: a large tool output lands in `parts`, then every later text
    // delta re-clones the whole message. `readUIMessageStream` does exactly
    // that (one `structuredClone(state.message)` per chunk it writes), so the
    // turn costs O(deltas × message size) on the shared event loop. The
    // single-pass path must clone NOTHING per delta. Counting calls on the
    // global is deterministic where a timing bound would flake on CI; the
    // legacy path is run on the same input as the positive control.
    const DELTAS = 2_000;
    const toolOutput = { marker: "tool-output", payload: "x".repeat(200 * 1024) };
    const big = () =>
      encode(async ({ writer }) => {
        writer.write({ type: "start", messageId: "asst_big" });
        writer.write({
          type: "tool-input-available",
          toolCallId: "call_1",
          toolName: "invoke_operation",
          input: { op: "x" },
        });
        writer.write({ type: "tool-output-available", toolCallId: "call_1", output: toolOutput });
        writer.write({ type: "text-start", id: "t" });
        for (let i = 0; i < DELTAS; i += 1)
          writer.write({ type: "text-delta", id: "t", delta: "a" });
        writer.write({ type: "text-end", id: "t" });
        writer.write({ type: "finish" });
      });

    const originalClone = globalThis.structuredClone;
    let clones = 0;
    globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
      clones += 1;
      return originalClone(value, options);
    }) as typeof structuredClone;
    try {
      const fresh = await extractAssistantMessage(big());
      const freshClones = clones;

      clones = 0;
      const legacy = await legacyExtract(big());
      const legacyClones = clones;

      // Negative control: the baseline clones on (at least) every delta, so a
      // regression back to a per-chunk snapshot is a count in the thousands.
      expect(legacyClones).toBeGreaterThan(DELTAS / 2);
      expect(freshClones).toBe(0);

      // Equivalence: same message, same parts, same 200 KB output — once.
      expect(fresh).toEqual(legacy);
      expect(textOf(fresh!)).toBe("a".repeat(DELTAS));
      const output = (fresh!.parts as Array<{ type: string; output?: unknown }>).find(
        (p) => p.type === "tool-invoke_operation",
      )?.output;
      expect(output).toEqual(toolOutput);
    } finally {
      globalThis.structuredClone = originalClone;
    }
  });

  it("returns undefined for a stream that carries no `start` (a lone error chunk)", async () => {
    // The processor seeds an empty assistant message before the first chunk,
    // so "no message" has to be decided on what was seen, not on what the
    // processor hands back. A turn that failed before its `start` (only ever
    // an `error` chunk on the wire) must not persist an empty assistant row.
    const body = encode(async ({ writer }) => {
      writer.write({ type: "error", errorText: "boom" });
    });
    const errorSpy = mock(() => {});
    const original = logger.error;
    logger.error = errorSpy as unknown as typeof logger.error;
    try {
      expect(await extractAssistantMessage(body)).toBeUndefined();
      // The error chunk is reported once and never thrown.
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      logger.error = original;
    }
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
