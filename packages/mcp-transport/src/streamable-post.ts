// SPDX-License-Identifier: Apache-2.0

/**
 * Serving one stateless Streamable HTTP POST: answer JSON unless the caller
 * asked for progress, and keep the per-request server alive until an SSE
 * answer is over. Shared by every MCP endpoint that builds a fresh
 * `Server` + `WebStandardStreamableHTTPServerTransport` per request.
 */

import { isJSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";

/** A POSTed MCP body, parsed once for both the transport choice and the SDK. */
export interface McpPost {
  payload: unknown;
  /**
   * Whether it holds a request asking for progress — `params._meta.progressToken`,
   * the MCP spec's opt-in, on any request of a batch. Such a call is answered
   * over SSE, so a long tool call stays alive through client first-byte timers
   * and proxy idle limits.
   */
  requestsProgress: boolean;
}

/**
 * `body` as an MCP POST, or `null` when it is not JSON — the SDK then reads the
 * bytes itself and answers its own `-32700`. Validation stays the SDK's.
 */
export function parseMcpPost(body: ArrayBuffer | Uint8Array): McpPost | null {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  const messages: unknown[] = Array.isArray(payload) ? payload : [payload];
  return {
    payload,
    requestsProgress: messages.some(
      (message) => isJSONRPCRequest(message) && message.params?._meta?.progressToken !== undefined,
    ),
  };
}

/** An SSE comment: clients ignore it, but it makes Bun send the headers at once. */
const SSE_OPEN_COMMENT = ": stream open\n\n";

/**
 * `response` with its SSE body re-exposed: it opens with a comment, then passes
 * the SDK's stream through unchanged, and runs `release` exactly once when that
 * is over — drained, failed, or cancelled by the client.
 *
 * The comment is there because Bun sends response headers with the first body
 * chunk, and the SDK's first write is otherwise its 15 s keep-alive or the
 * tool's first progress. A cancel is passed on to the SDK's stream first;
 * `release` closing the transport then aborts the in-flight handler's
 * `extra.signal`, so a gone client stops the work.
 */
export function releaseWhenSettled(response: Response, release: () => Promise<void>): Response {
  // An SSE response: the SDK always gives it a body.
  const reader = response.body!.getReader();
  let released = false;
  const settle = async () => {
    if (released) return;
    released = true;
    await release();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(SSE_OPEN_COMMENT));
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (!done) {
          controller.enqueue(value);
          return;
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
      await settle();
    },
    async cancel(reason) {
      await reader.cancel(reason);
      await settle();
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}

/** Whether `response` is an SSE answer, i.e. one still being written after it is returned. */
export function isSseResponse(response: Response): boolean {
  return (
    response.body !== null &&
    (response.headers.get("content-type")?.startsWith("text/event-stream") ?? false)
  );
}
