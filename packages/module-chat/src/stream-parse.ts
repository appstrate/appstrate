// SPDX-License-Identifier: Apache-2.0

/**
 * Reconstruct the final assistant `UIMessage` from an AI SDK UI-message stream
 * (SSE bytes). The chat engine emits the wire format
 * (`toUIMessageStreamResponse`), so parsing one teed copy of the response body
 * server-side lets the chat module persist the assistant turn uniformly —
 * without a per-engine persistence callback or a core-contract change.
 */

import { consumeStream, createUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { parseSseFrames, parseSseJsonData } from "@appstrate/core/sse";
import { logger } from "./logger.ts";

/**
 * Decode an AI SDK UI-message SSE byte stream into its chunk objects.
 *
 * Exported for the equivalence tests, which feed identical input to the AI
 * SDK's `readUIMessageStream` and to {@link extractAssistantMessage}.
 */
export function sseToChunks(
  byteStream: ReadableStream<Uint8Array>,
): ReadableStream<UIMessageChunk> {
  const decoder = new TextDecoder();
  let buffer = "";
  // Fail loud, but only once per stream: a malformed frame is dropped (never
  // thrown — throwing would fail the persist drain and lose the whole turn), yet
  // silently swallowing it hid real corruption. Log the first offender only so a
  // pathological stream can't flood the log.
  let loggedParseError = false;
  return byteStream.pipeThrough(
    new TransformStream<Uint8Array, UIMessageChunk>({
      transform(bytes, controller) {
        const parsed = parseSseFrames(decoder.decode(bytes, { stream: true }), buffer);
        buffer = parsed.buffer;
        for (const frame of parsed.frames) {
          const chunk = parseSseJsonData(frame.data);
          if (chunk !== null) {
            controller.enqueue(chunk as UIMessageChunk);
            continue;
          }
          // parseSseJsonData returns null for the empty / [DONE] / malformed
          // cases alike. Empty and [DONE] are expected terminators; a
          // non-empty, non-[DONE] payload that still parses to null is a
          // malformed frame. Drop it either way (never throw — that would
          // fail the persist drain and lose the whole turn), but fail loud on
          // the first real corruption so it isn't silently swallowed.
          const data = frame.data;
          if (data && data !== "[DONE]" && !loggedParseError) {
            loggedParseError = true;
            logger.error("chat sse frame parse failed", { preview: data.slice(0, 300) });
          }
        }
      },
    }),
  );
}

/**
 * Drain the stream and return the turn's assistant message, or `undefined` when
 * it produced none.
 *
 * A turn carries exactly ONE top-level `start`, from exactly one of three
 * writers: `engine.ts` writes it before iterating the Pi session; `closePiTurn`
 * writes it only when that never happened (a setup failure); and
 * `PiChatUiStreamMapper.map` emits the per-turn `start-step`/`finish-step`
 * boundaries but never a `start`. So the whole stream assembles ONE message,
 * and only its final state matters.
 *
 * Single pass, no per-chunk snapshot: `createUIMessageStream`'s `onFinish`
 * (`handleUIMessageStreamFinish`) runs the AI SDK's message processor with a
 * no-op `write` and hands over `state.message` itself, uncloned, once, when
 * the merged stream ends — the `flush()` of its terminal transform. (The
 * SDK's `readUIMessageStream` would instead `structuredClone` the whole
 * in-progress message on EVERY chunk, O(chunks × message size) on the event
 * loop every other user's stream shares, for a snapshot only read once.) Verified
 * against the vendored source: an `error` chunk only reaches `onError` and does
 * not stop the stream, so `onFinish` still fires; `isAborted` only reports an
 * `abort` chunk (the AI SDK's client-abort marker, which this engine never
 * emits) and does not change what is returned.
 *
 * "Produced none" is "no `start` was seen": the processor seeds an empty
 * assistant message before the first chunk, so `onFinish` always has one to
 * hand over, and the `start` chunk is the one every writer above emits exactly
 * once per turn. A stream that ends without it (nothing at all, or a lone
 * `error` chunk) yields `undefined`.
 *
 * Reading the stream to the end is what drives generation to completion on this
 * teed branch — the disconnect-survival guarantee (see `finalize-stream.ts`).
 */
export async function extractAssistantMessage(
  byteStream: ReadableStream<Uint8Array>,
): Promise<UIMessage | undefined> {
  let sawStart = false;
  const chunks = sseToChunks(byteStream).pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === "start") sawStart = true;
        controller.enqueue(chunk);
      },
    }),
  );

  // Same contract as the frame decoder above: a processing failure (the
  // processor throws on a semantically broken sequence, e.g. a delta for a part
  // that was never started; the decoder throws past its frame-size bound) is
  // logged once and never thrown — a throw would fail the persist drain and
  // lose the turn. `createUIMessageStream` turns a rejection of the merged
  // stream into an `error` chunk through `onError`, and `consumeStream` reports
  // a failure of the processor pipe through its own `onError`; both land here.
  let loggedProcessError = false;
  const reportProcessError = (err: unknown): void => {
    if (loggedProcessError) return;
    loggedProcessError = true;
    logger.error("chat ui stream processing failed", { err: String(err) });
  };

  let assembled: UIMessage | undefined;
  const stream = createUIMessageStream<UIMessage>({
    execute: ({ writer }) => {
      writer.merge(chunks);
    },
    onError: (err) => {
      reportProcessError(err);
      return "chat ui stream processing failed";
    },
    onFinish: ({ responseMessage }) => {
      assembled = responseMessage;
    },
  });
  await consumeStream({ stream, onError: reportProcessError });

  if (!sawStart || !assembled) return undefined;
  return assembled.role === "assistant" ? assembled : undefined;
}
