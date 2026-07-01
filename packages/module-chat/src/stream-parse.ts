// SPDX-License-Identifier: Apache-2.0

/**
 * Reconstruct the final assistant `UIMessage` from an AI SDK UI-message stream
 * (SSE bytes). Both chat engines emit the same wire format
 * (`toUIMessageStreamResponse`), so parsing one teed copy of the response body
 * server-side lets the chat module persist the assistant turn uniformly —
 * without a per-engine persistence callback or a core-contract change.
 */

import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
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
              // Drop the malformed fragment rather than failing the whole parse.
              if (!loggedParseError) {
                loggedParseError = true;
                logger.error("chat sse frame parse failed", { preview: data.slice(0, 300) });
              }
            }
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
 * wins) — a single turn can carry more than one assistant message (the
 * claude-agent engine emits several), and keeping only the last would drop the
 * earlier ones from persistence. Reading the whole stream is what drives
 * generation to completion on this teed branch.
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
  return [...byId.values()];
}
