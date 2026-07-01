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

/** Decode an AI SDK UI-message SSE byte stream into its chunk objects. */
function sseToChunks(byteStream: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> {
  const decoder = new TextDecoder();
  let buffer = "";
  return byteStream.pipeThrough(
    new TransformStream<Uint8Array, UIMessageChunk>({
      transform(bytes, controller) {
        const parsed = parseSseFrames(decoder.decode(bytes, { stream: true }), buffer);
        buffer = parsed.buffer;
        for (const frame of parsed.frames) {
          // null covers the empty / [DONE] / malformed-fragment cases —
          // skip the frame rather than failing the whole parse.
          const chunk = parseSseJsonData(frame.data);
          if (chunk !== null) controller.enqueue(chunk as UIMessageChunk);
        }
      },
    }),
  );
}

/**
 * Drain the stream and return the last assembled message (the assistant turn),
 * or `undefined` if the stream yielded none. Reading the whole stream is what
 * drives generation to completion on this teed branch.
 */
export async function extractAssistantMessage(
  byteStream: ReadableStream<Uint8Array>,
): Promise<UIMessage | undefined> {
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream: sseToChunks(byteStream) })) {
    last = message;
  }
  return last;
}
