// SPDX-License-Identifier: Apache-2.0

import { MCP_RESOURCE_MAX_BYTES } from "@appstrate/core/mcp-result";

// The 32 MiB decoded limit may travel as base64. Allow the envelope and metadata too.
const MAX_WIRE_BYTES = MCP_RESOURCE_MAX_BYTES * 1.5;

/**
 * Bound what the SDK can buffer before parsing a resource. A shared GET can carry results for
 * many requests: bound each SSE event there, never the lifetime of the stream.
 */
export function boundResourceResponse(
  response: Response,
  kind: "request" | "shared-stream",
  maxBytes = MAX_WIRE_BYTES,
): Response {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  // The SDK can consume a refusal as text even if its Content-Type advertises SSE.
  const eventStream = kind === "shared-stream" && response.ok && mediaType === "text/event-stream";
  if (!response.body) return response;

  let bytes = 0;
  let lineStart = true;
  let afterCR = false;
  const overflow = () => new Error(`MCP resource response exceeds the ${maxBytes}-byte wire limit`);
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!eventStream) {
          bytes += chunk.byteLength;
          if (bytes > maxBytes) throw overflow();
        } else {
          // SSE dispatches on an empty line. LF, CR and CRLF (including across chunks) are
          // all line endings. Count the entire event, including multi-line data and metadata.
          for (const byte of chunk) {
            if (byte === 10 && afterCR) {
              afterCR = false;
              if (bytes === 0) continue; // final LF of an empty CRLF line
            } else {
              afterCR = byte === 13;
              if (afterCR || byte === 10) {
                if (lineStart) {
                  bytes = 0;
                  continue;
                }
                lineStart = true;
              } else {
                lineStart = false;
              }
            }
            if (++bytes > maxBytes) throw overflow();
          }
        }
        controller.enqueue(chunk);
      },
    }),
  );
  // Constructing a Response drops the fetch URL and redirect flag; EventSource uses both.
  return Object.defineProperties(new Response(body, response), {
    url: { value: response.url },
    redirected: { value: response.redirected },
  });
}
