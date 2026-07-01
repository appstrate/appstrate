// SPDX-License-Identifier: Apache-2.0

/**
 * Reconstruct the final assistant `UIMessage` from an AI SDK UI-message stream
 * (SSE bytes). Both chat engines emit the same wire format
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
 * Drain the stream and return the FINAL state of EACH assembled message, in
 * order of first appearance. `readUIMessageStream` re-emits an evolving snapshot
 * per message as chunks arrive, so we key a Map by message id (last snapshot
 * wins). Both engines emit a single top-level `start` per turn today, so the
 * multi-message handling is defensive — but it is what makes a future
 * multi-message engine safe to add without silently dropping or duplicating
 * content. Reading the whole stream is what drives generation to completion on
 * this teed branch.
 */
export async function extractAssistantMessages(
  byteStream: ReadableStream<Uint8Array>,
): Promise<UIMessage[]> {
  const byId = new Map<string, UIMessage>();
  for await (const message of readUIMessageStream({ stream: sseToChunks(byteStream) })) {
    // Map insertion order is fixed at first `set` of a key; re-setting updates
    // the snapshot without moving it — so order = first appearance, value = last.
    byId.set(message.id, message);
  }
  const snapshots = [...byId.values()];
  // ai-sdk v6 `readUIMessageStream` carries parts forward across a mid-stream
  // `start` boundary (it relabels the message id rather than resetting parts),
  // so each later snapshot is cumulative: message N begins with everything
  // message N-1 already held. Persisting that verbatim would duplicate the
  // earlier messages' content in the later rows — strip the carried prefix.
  // Comparing against the PREVIOUS snapshot (itself cumulative) covers the
  // whole run of prior messages.
  return snapshots.map((message, i) => {
    if (i === 0) return message;
    const prevParts = snapshots[i - 1]!.parts;
    const carried =
      prevParts.length > 0 &&
      message.parts.length >= prevParts.length &&
      prevParts.every(
        (part, j) =>
          part === message.parts[j] || JSON.stringify(part) === JSON.stringify(message.parts[j]),
      );
    return carried ? { ...message, parts: message.parts.slice(prevParts.length) } : message;
  });
}
