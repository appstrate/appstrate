// SPDX-License-Identifier: Apache-2.0

/**
 * The transport choice of `/api/mcp/o/:org` (#1844): a `tools/call` carrying
 * `params._meta.progressToken` is answered over SSE — headers at once, the
 * result as an event when the tool finishes — and every other call keeps the
 * plain JSON response.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, orgOnlyHeaders } from "../../helpers/auth.ts";
import { MCP_ACCEPT, mcpPath, sseMessages, type JsonRpcEnvelope } from "../../helpers/mcp.ts";
import { registerTestPlatformApp } from "../../helpers/platform-app.ts";

const app = getTestApp();
await registerTestPlatformApp();

let headers: Record<string, string>;

/** POST a `search_operations` call, with `_meta` when given. */
async function searchOperations(meta?: Record<string, unknown>): Promise<Response> {
  return app.request(mcpPath(headers), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "search_operations",
        arguments: { query: "agent", limit: 3 },
        ...(meta ? { _meta: meta } : {}),
      },
    }),
  });
}

/** The operations count `search_operations` reports in its text block. */
function searchTotal(envelope: JsonRpcEnvelope): number {
  const [first] = envelope.result?.content as Array<{ text: string }>;
  return (JSON.parse(first!.text) as { total: number }).total;
}

describe("mcp transport: SSE only when progress is asked for", () => {
  beforeEach(async () => {
    await truncateAll();
    headers = orgOnlyHeaders(await createTestContext());
  });

  it("streams a tools/call carrying a progressToken and ends the stream with its result", async () => {
    const res = await searchOperations({ progressToken: "progress-1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/event-stream");

    // `text()` resolving at all proves the stream was closed after the result.
    const messages = sseMessages(await res.text());
    const results = messages.filter((m) => m.result !== undefined || m.error !== undefined);
    expect(results).toHaveLength(1);
    expect(results[0]!.error).toBeUndefined();
    expect(searchTotal(results[0]!)).toBeGreaterThan(0);
  });

  it("keeps the plain JSON response for the same call without a progressToken", async () => {
    const res = await searchOperations();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("application/json");
    const envelope = (await res.json()) as JsonRpcEnvelope;
    expect(searchTotal(envelope)).toBeGreaterThan(0);
  });

  it("answers an unparseable body as JSON, through the SDK's own parse error", async () => {
    const res = await app.request(mcpPath(headers), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":{"progressToken":"x"',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toStartWith("application/json");
    const envelope = (await res.json()) as JsonRpcEnvelope;
    expect(envelope.error?.code).toBe(-32700);
  });
});
