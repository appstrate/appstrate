// SPDX-License-Identifier: Apache-2.0

/**
 * Reconstruct the final assistant `UIMessage` from an AI SDK UI-message stream
 * (SSE bytes). Both chat engines emit the same wire format
 * (`toUIMessageStreamResponse`), so parsing one teed copy of the response body
 * server-side lets the chat module persist the assistant turn uniformly —
 * without a per-engine persistence callback or a core-contract change.
 */

import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";

/** Decode an AI SDK UI-message SSE byte stream into its chunk objects. */
function sseToChunks(byteStream: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> {
  const decoder = new TextDecoder();
  let buffer = "";
  return byteStream.pipeThrough(
    new TransformStream<Uint8Array, UIMessageChunk>({
      transform(bytes, controller) {
        buffer += decoder.decode(bytes, { stream: true });
        let sep: number;
        // SSE events are separated by a blank line; each carries one `data:` line.
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              controller.enqueue(JSON.parse(data) as UIMessageChunk);
            } catch {
              // Ignore a malformed SSE fragment rather than failing the whole parse.
            }
          }
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
