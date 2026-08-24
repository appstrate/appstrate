// SPDX-License-Identifier: Apache-2.0

/**
 * Reconstruct the final assistant `UIMessage` from an AI SDK UI-message stream
 * (SSE bytes). The chat engine emits the wire format
 * (`toUIMessageStreamResponse`), so parsing one teed copy of the response body
 * server-side lets the chat module persist the assistant turn uniformly —
 * without a per-engine persistence callback or a core-contract change.
 */

import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { parseSseFrames, parseSseJsonData } from "@appstrate/core/sse";
import { logger } from "./logger.ts";

/** Decode an AI SDK UI-message SSE byte stream into its chunk objects. */
function sseToChunks(byteStream: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> {
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
 * boundaries but never a `start`. So `readUIMessageStream` re-emits an evolving
 * snapshot of a single message and the LAST one is the whole turn.
 *
 * Reading the stream to the end is what drives generation to completion on this
 * teed branch — the disconnect-survival guarantee (see `finalize-stream.ts`).
 */
export async function extractAssistantMessage(
  byteStream: ReadableStream<Uint8Array>,
): Promise<UIMessage | undefined> {
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream: sseToChunks(byteStream) })) {
    last = message;
  }
  return last?.role === "assistant" ? last : undefined;
}
