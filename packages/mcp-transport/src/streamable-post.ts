// SPDX-License-Identifier: Apache-2.0

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isJSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";

export interface McpPost {
  payload: unknown;
  /** A request of it carries `_meta.progressToken`: answer over SSE so progress can keep it alive. */
  requestsProgress: boolean;
}

/** `null` when not JSON: the SDK then reads the bytes itself and answers its own `-32700`. */
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

/** Bun sends headers with the first body chunk; this comment sends them at once. */
const SSE_OPEN_COMMENT = ": stream open\n\n";

/**
 * Runs `release` once the SSE body is drained, failed or cancelled. Releasing
 * closes the transport, which aborts the handler's `extra.signal` on a cancel.
 */
function releaseWhenSettled(response: Response, release: () => Promise<void>): Response {
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

function isSseResponse(response: Response): boolean {
  return (
    response.body !== null &&
    (response.headers.get("content-type")?.startsWith("text/event-stream") ?? false)
  );
}

/** An SSE answer is still being written by the tool: the pair must outlive it. */
export async function serveStatelessPost(
  server: Server,
  transport: WebStandardStreamableHTTPServerTransport,
  request: Request,
  post: McpPost | null,
): Promise<Response> {
  const release = async () => {
    try {
      await transport.close();
    } finally {
      await server.close();
    }
  };
  let response: Response;
  try {
    await server.connect(transport);
    response = await transport.handleRequest(
      request,
      post ? { parsedBody: post.payload } : undefined,
    );
  } catch (err) {
    await release();
    throw err;
  }
  if (isSseResponse(response)) return releaseWhenSettled(response, release);
  await release();
  return response;
}

/**
 * Answer one POST of an authenticated endpoint with `server` on a fresh
 * stateless transport: no session, a JSON answer unless a request asks for
 * progress, and the SDK's Host-header allowlist off — it would reject
 * reverse-proxied hosts, and the DNS-rebinding attack it guards against (a
 * browser driving a localhost server) needs an endpoint that answers without
 * the caller's credential. `body` holds the request's bytes, already read by
 * the caller, and `post` their {@link parseMcpPost} parse; the SDK reads the
 * bytes itself only when they did not parse.
 */
export function serveAuthenticatedStatelessPost(
  server: Server,
  request: Request,
  body: ArrayBuffer,
  post: McpPost | null,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: !post?.requestsProgress,
    enableDnsRebindingProtection: false,
  });
  const forwarded = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  });
  return serveStatelessPost(server, transport, forwarded, post);
}
