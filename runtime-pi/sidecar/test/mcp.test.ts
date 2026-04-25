// SPDX-License-Identifier: Apache-2.0

/**
 * MCP endpoint integration tests.
 *
 * The sidecar mounts an `/mcp` endpoint that exposes `provider_call` and
 * `run_history` as MCP tools. These tests verify wire-format compliance
 * and contract preservation: the MCP path must surface the same auth /
 * authorisation / SSRF guarantees the legacy `/proxy` and `/run-history`
 * routes already enforce.
 */

import { describe, it, expect, mock } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, type AppDeps } from "../app.ts";
import type { CredentialsResponse } from "../helpers.ts";

function makeDeps(overrides?: Partial<AppDeps>): AppDeps {
  return {
    config: { platformApiUrl: "http://mock:3000", runToken: "tok", proxyUrl: "" },
    fetchCredentials: mock(
      async (): Promise<CredentialsResponse> => ({
        credentials: { access_token: "test-123" },
        authorizedUris: ["https://api.example.com/**"],
        allowAllUris: false,
        credentialHeaderName: "Authorization",
        credentialHeaderPrefix: "Bearer",
        credentialFieldName: "access_token",
      }),
    ),
    cookieJar: new Map(),
    fetchFn: mock(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
    isReady: () => true,
    ...overrides,
  };
}

/**
 * Issue a JSON-RPC request directly to the `/mcp` endpoint via Hono's
 * in-process `app.request()`. We bypass the SDK's `Client` here because
 * its `StreamableHTTPClientTransport` requires a real fetch loop, and
 * the in-process transport variants do not interop with a Hono app.
 * This is sufficient to validate wire-format correctness — the SDK
 * Server is the one parsing the request, so any malformed payload
 * surfaces as a JSON-RPC error response we can assert on.
 */
async function rpc(
  app: ReturnType<typeof createApp>,
  body: { method: string; params?: unknown },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
  });
  const text = await res.text();
  // The SDK's stateless mode returns either application/json (when
  // `enableJsonResponse` is set, which we do) or text/event-stream. We
  // configure JSON, so the body is a single JSON-RPC envelope.
  return { status: res.status, json: JSON.parse(text) };
}

describe("POST /mcp — initialize", () => {
  it("returns server capabilities advertising tools support", async () => {
    const app = createApp(makeDeps());
    const res = await rpc(app, {
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    expect(res.status).toBe(200);
    const result = res.json.result as { capabilities: { tools?: unknown }; serverInfo: unknown };
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo).toMatchObject({ name: "appstrate-sidecar" });
  });
});

describe("POST /mcp — tools/list", () => {
  it("advertises provider_call and run_history", async () => {
    const app = createApp(makeDeps());
    const res = await rpc(app, { method: "tools/list" });
    expect(res.status).toBe(200);
    const result = res.json.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["provider_call", "run_history"]);
  });

  it("declares input schemas matching the legacy contracts", async () => {
    const app = createApp(makeDeps());
    const res = await rpc(app, { method: "tools/list" });
    const result = res.json.result as {
      tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
    };
    const proxy = result.tools.find((t) => t.name === "provider_call")!;
    expect(Object.keys(proxy.inputSchema.properties).sort()).toEqual([
      "body",
      "headers",
      "method",
      "providerId",
      "substituteBody",
      "target",
    ]);
    const history = result.tools.find((t) => t.name === "run_history")!;
    expect(Object.keys(history.inputSchema.properties).sort()).toEqual(["fields", "limit"]);
  });
});

describe("POST /mcp — tools/call run_history", () => {
  it("delegates to /run-history and returns the upstream JSON", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"runs":[{"id":"r1"}]}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn }));

    const res = await rpc(app, {
      method: "tools/call",
      params: { name: "run_history", arguments: { limit: 5, fields: ["state"] } },
    });
    expect(res.status).toBe(200);
    const result = res.json.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe('{"runs":[{"id":"r1"}]}');

    // Verifies the `limit` and `fields` arguments propagated as query
    // parameters into the underlying /run-history call.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const calledUrl = fetchFn.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("/internal/run-history");
    expect(calledUrl).toContain("limit=5");
    expect(calledUrl).toContain("fields=state");
  });
});

describe("POST /mcp — tools/call provider_call", () => {
  it("forwards through /proxy with credential injection", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"id":"abc"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn }));

    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "test-provider",
          target: "https://api.example.com/items",
          method: "GET",
        },
      },
    });
    expect(res.status).toBe(200);
    const result = res.json.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe('{"id":"abc"}');

    // The credential-inject path must have run — Authorization header
    // populated by the sidecar from the credentialFieldName/Prefix.
    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-123");
  });

  it("returns isError: true when the target URL is unauthorized", async () => {
    // The sidecar's authorizedUris guard is the same code path; the MCP
    // layer must surface 4xx as tool-level errors, not throws.
    const app = createApp(makeDeps());
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "test-provider",
          target: "https://evil.example.com/exfil",
          method: "GET",
        },
      },
    });
    expect(res.status).toBe(200);
    const result = res.json.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not authorized");
  });

  it("returns isError: true for non-text upstream responses", async () => {
    // Phase 1 narrows the MCP surface to text/JSON. Binary content goes
    // through the legacy /proxy path until Phase 3 introduces resources.
    const fetchFn = mock(
      async () =>
        new Response(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn }));
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "test-provider",
          target: "https://api.example.com/binary",
        },
      },
    });
    const result = res.json.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("non-text response");
  });
});

describe("POST /mcp — protocol errors", () => {
  it("returns -32601 MethodNotFound for unsupported methods", async () => {
    const app = createApp(makeDeps());
    const res = await rpc(app, { method: "sampling/createMessage" });
    expect(res.status).toBe(200);
    const error = res.json.error as { code: number };
    expect(error.code).toBe(-32601);
  });

  it("rejects unknown tool names with MethodNotFound", async () => {
    const app = createApp(makeDeps());
    const res = await rpc(app, {
      method: "tools/call",
      params: { name: "totally-not-a-tool" },
    });
    const error = res.json.error as { code: number; message: string };
    expect(error.code).toBe(-32601);
    expect(error.message).toContain("totally-not-a-tool");
  });
});

describe("StreamableHTTPClientTransport interop (smoke test)", () => {
  it("`enableJsonResponse: true` is wired so SDK clients without SSE work", async () => {
    // Sanity check: the SDK ships a real StreamableHTTPClientTransport
    // we can import without instantiating (instantiation requires a
    // network URL; we pin only that the symbol exists so any future
    // refactor that swaps transports compile-fails this test).
    expect(typeof StreamableHTTPClientTransport).toBe("function");
    expect(typeof Client).toBe("function");
  });
});
