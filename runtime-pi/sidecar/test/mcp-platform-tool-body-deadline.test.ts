// SPDX-License-Identifier: Apache-2.0

/**
 * The 30 s deadline on `run_history` / `recall_memory` bounds the WHOLE
 * request — headers AND body — which is what we want: there is no long-lived
 * stream here to keep open. But it therefore stays armed while the body is
 * read, so "headers at 29 s, then a slow body" aborts DURING the read, one
 * `await` past the point where the identical failure produces a structured
 * result.
 *
 * That second abort used to escape: the `try/catch` wrapped only the `fetch`,
 * while `responseToToolResult` (which consumes the body) sat outside it. The
 * agent saw a raw JSON-RPC error for a mid-body timeout and a readable
 * `isError` tool result for a header-time one — the same failure, two shapes.
 *
 * The header-time half is covered in `mcp.test.ts` ("first-party platform
 * calls are deadline-bounded"); this file owns the mid-body half and the
 * assertion that the two now agree.
 *
 * A body that errors is exactly what an aborted `fetch` hands back, so the
 * fake platform returns a `Response` whose stream rejects — no fake timers
 * needed, and no 30 s wall-clock wait.
 */

import { describe, it, expect } from "bun:test";
import { createTestApp } from "./helpers/authed-app.ts";
import type { AppDeps } from "../app.ts";

/** JSON-RPC envelope, either shape. */
interface RpcEnvelope {
  result?: { content: Array<{ text: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

function makeDeps(fetchFn: typeof fetch): AppDeps {
  return {
    config: { platformApiUrl: "http://mock:3000", runToken: "tok", proxyUrl: "" },
    cookieJar: new Map(),
    fetchFn,
    isReady: () => true,
  };
}

async function callTool(fetchFn: typeof fetch, tool: string): Promise<RpcEnvelope> {
  const app = createTestApp(makeDeps(fetchFn));
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Host: "localhost",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: {} },
    }),
  });
  return JSON.parse(await res.text()) as RpcEnvelope;
}

/**
 * A platform that answers with headers, then fails mid-body with the error an
 * aborted `fetch` raises. `Content-Length` is deliberately absent — a body
 * that dies partway is exactly the chunked case.
 */
function bodyAbortsFetch(reason: Error): typeof fetch {
  return (async (): Promise<Response> => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        controller.error(reason);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function timeoutError(): Error {
  const err = new Error("The operation timed out.");
  err.name = "TimeoutError";
  return err;
}

describe("POST /mcp — the deadline also caps the body read, in one failure shape", () => {
  for (const tool of ["run_history", "recall_memory"] as const) {
    it(`${tool}: a mid-body timeout is a tool result, not a raw rejection`, async () => {
      const envelope = await callTool(bodyAbortsFetch(timeoutError()), tool);

      // The regression this pins: an escaped throw surfaces as a JSON-RPC
      // `error` member with no `result` at all.
      expect(envelope.error).toBeUndefined();
      expect(envelope.result).toBeDefined();
      expect(envelope.result!.isError).toBe(true);
      // Byte-identical to what the SAME failure produces at header time
      // (`mcp.test.ts`), which is the whole point — one deadline, one shape.
      expect(envelope.result!.content[0]!.text).toBe(
        `${tool}: upstream fetch timed out after 30000ms`,
      );
    });

    it(`${tool}: a mid-body caller abort is a tool result too`, async () => {
      const abort = new Error("This operation was aborted");
      abort.name = "AbortError";
      const envelope = await callTool(bodyAbortsFetch(abort), tool);

      expect(envelope.error).toBeUndefined();
      expect(envelope.result!.isError).toBe(true);
      expect(envelope.result!.content[0]!.text).toBe(`${tool}: upstream fetch aborted`);
    });

    // Acceptance control: the same tool, on the same path, against a platform
    // whose body arrives intact. Without it the two cases above would pass on
    // a handler that reported `isError` for everything.
    it(`${tool}: a body that arrives intact is still returned verbatim`, async () => {
      const ok = (async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch;
      const envelope = await callTool(ok, tool);

      expect(envelope.error).toBeUndefined();
      expect(envelope.result!.isError).toBeUndefined();
      expect(envelope.result!.content[0]!.text).toBe('{"ok":true}');
    });
  }
});
