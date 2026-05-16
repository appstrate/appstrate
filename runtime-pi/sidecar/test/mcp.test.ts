// SPDX-License-Identifier: Apache-2.0

/**
 * MCP endpoint integration tests.
 *
 * The sidecar mounts `/mcp` and exposes `provider_call`, `run_history`,
 * and `recall_memory` as MCP tools. These tests verify wire-format
 * compliance and the auth / authorisation / SSRF guarantees that the
 * MCP path enforces end-to-end.
 */

import { describe, it, expect, mock } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, type AppDeps } from "../app.ts";
import { MAX_MCP_ENVELOPE_SIZE, MAX_REQUEST_BODY_SIZE } from "../helpers.ts";
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
      // Hono's `app.request()` does not synthesise a Host header. Real
      // HTTP/1.1 clients (the agent container, mcp-inspector, the SDK
      // Client) always send one. We set it explicitly here so the
      // sidecar's DNS-rebinding guard (`ALLOWED_HOSTNAMES`) accepts
      // the test request.
      Host: "localhost",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
  });
  const text = await res.text();
  // The SDK's stateless mode returns either application/json (when
  // `enableJsonResponse` is set, which we do) or text/event-stream. We
  // configure JSON, so the body is a single JSON-RPC envelope.
  return { status: res.status, json: JSON.parse(text) };
}

describe("ALL /mcp — Host header validation (DNS-rebinding defence)", () => {
  // The sidecar runs the host-header check itself (port-tolerant)
  // because the SDK's built-in `allowedHosts` does an exact match
  // including the port. The process orchestrator (used by
  // `appstrate run` and tests) maps the sidecar to a *dynamic* port
  // on `localhost`, so an exact-match list would reject every legit
  // call.

  function rawMcp(app: ReturnType<typeof createApp>, host: string | null) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (host !== null) headers.Host = host;
    return app.request("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  }

  it("accepts the docker bridge alias (sidecar:8080)", async () => {
    const res = await rawMcp(createApp(makeDeps()), "sidecar:8080");
    expect(res.status).toBe(200);
  });

  it("accepts localhost with a dynamic port (process orchestrator)", async () => {
    const res = await rawMcp(createApp(makeDeps()), "localhost:51123");
    expect(res.status).toBe(200);
  });

  it("accepts 127.0.0.1 with a dynamic port", async () => {
    const res = await rawMcp(createApp(makeDeps()), "127.0.0.1:62000");
    expect(res.status).toBe(200);
  });

  it("accepts portless hostnames (Hono test default)", async () => {
    const res = await rawMcp(createApp(makeDeps()), "localhost");
    expect(res.status).toBe(200);
  });

  it("rejects unknown hosts with 403 + JSON-RPC error envelope", async () => {
    const res = await rawMcp(createApp(makeDeps()), "evil.example.com:8080");
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      jsonrpc: string;
      error: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain("Invalid Host header");
    expect(body.error.message).toContain("evil.example.com");
  });

  it("rejects a Host header that matches the suffix only (e.g. notlocalhost)", async () => {
    const res = await rawMcp(createApp(makeDeps()), "notlocalhost:8080");
    expect(res.status).toBe(403);
  });

  it("rejects a missing Host header", async () => {
    // `app.request()` won't send a Host header unless we set one
    // explicitly. The validator must fail closed in that case.
    const res = await rawMcp(createApp(makeDeps()), null);
    expect(res.status).toBe(403);
  });
});

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
  it("advertises provider_call, run_history, and recall_memory", async () => {
    const app = createApp(makeDeps());
    const res = await rpc(app, { method: "tools/list" });
    expect(res.status).toBe(200);
    const result = res.json.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["provider_call", "recall_memory", "run_history"]);
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
    const recall = result.tools.find((t) => t.name === "recall_memory")!;
    expect(Object.keys(recall.inputSchema.properties).sort()).toEqual(["limit", "q"]);
  });

  // Regression — the agent-facing `run_history.fields` enum is the LLM's
  // single source of truth for the wire vocabulary. If the legacy `state`
  // value re-appears here, agents start sending it again and the platform
  // 400s every call. Lock it to the canonical AFPS 1.4+ values.
  it("advertises run_history.fields as exactly [checkpoint, result]", async () => {
    const app = createApp(makeDeps());
    const res = await rpc(app, { method: "tools/list" });
    const result = res.json.result as {
      tools: Array<{
        name: string;
        inputSchema: { properties: { fields?: { items?: { enum?: string[] } } } };
      }>;
    };
    const history = result.tools.find((t) => t.name === "run_history")!;
    expect(history.inputSchema.properties.fields?.items?.enum).toEqual(["checkpoint", "result"]);
  });
});

describe("POST /mcp — tools/call run_history", () => {
  it("delegates to the platform's /internal/run-history and returns the upstream JSON", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"object":"list","data":[{"id":"r1"}],"hasMore":false}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn }));

    const res = await rpc(app, {
      method: "tools/call",
      params: { name: "run_history", arguments: { limit: 5, fields: ["checkpoint"] } },
    });
    expect(res.status).toBe(200);
    const result = res.json.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe('{"object":"list","data":[{"id":"r1"}],"hasMore":false}');

    // Verifies the `limit` and `fields` arguments propagated as query
    // parameters into the underlying platform call.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const calledUrl = fetchFn.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("/internal/run-history");
    expect(calledUrl).toContain("limit=5");
    expect(calledUrl).toContain("fields=checkpoint");
  });
});

describe("POST /mcp — tools/call recall_memory", () => {
  it("delegates to the platform's /internal/memories and forwards q + limit", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"memories":[{"id":1,"content":"x"}]}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn }));

    const res = await rpc(app, {
      method: "tools/call",
      params: { name: "recall_memory", arguments: { q: "python", limit: 3 } },
    });
    expect(res.status).toBe(200);
    const result = res.json.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe('{"memories":[{"id":1,"content":"x"}]}');

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const calledUrl = fetchFn.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("/internal/memories");
    expect(calledUrl).toContain("q=python");
    expect(calledUrl).toContain("limit=3");
  });

  it("omits empty q from the upstream URL", async () => {
    const fetchFn = mock(async () => new Response('{"memories":[]}', { status: 200 }));
    const app = createApp(makeDeps({ fetchFn }));

    await rpc(app, {
      method: "tools/call",
      params: { name: "recall_memory", arguments: { limit: 1 } },
    });
    const calledUrl = fetchFn.mock.calls[0]![0] as string;
    expect(calledUrl).not.toContain("q=");
    expect(calledUrl).toContain("limit=1");
  });
});

describe("POST /mcp — tools/call provider_call", () => {
  it("forwards through executeProviderCall with credential injection", async () => {
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

  it("attaches upstream { status, headers } via _meta on success (text body)", async () => {
    // Header propagation regression test: the sidecar must surface
    // upstream HTTP status + allowlisted response headers under
    // `_meta['appstrate/upstream']` so the agent-side resolver can
    // drive resumable-upload protocols (Location, ETag, Upload-Offset).
    const fetchFn = mock(
      async () =>
        new Response('{"id":"abc"}', {
          status: 201,
          headers: {
            "Content-Type": "application/json",
            Location: "https://api.example.com/upload/session-123",
            ETag: '"v1-abc"',
            "Set-Cookie": "session=secret", // must NOT propagate
          },
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
          method: "POST",
          body: '{"x":1}',
        },
      },
    });
    expect(res.status).toBe(200);
    const result = res.json.result as {
      content: Array<{ text: string }>;
      _meta?: Record<string, unknown>;
    };
    expect(result._meta).toBeDefined();
    const meta = result._meta!["appstrate/upstream"] as {
      status: number;
      headers: Record<string, string>;
    };
    expect(meta.status).toBe(201);
    expect(meta.headers.location).toBe("https://api.example.com/upload/session-123");
    expect(meta.headers.etag).toBe('"v1-abc"');
    expect(meta.headers["content-type"]).toBe("application/json");
    // Cookie must not be propagated.
    expect(meta.headers).not.toHaveProperty("set-cookie");
    expect(meta.headers).not.toHaveProperty("authorization");
  });

  it("attaches upstream meta even on tool-level errors (4xx upstream)", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"error":"not found"}', {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "30",
          },
        }),
    );
    const app = createApp(makeDeps({ fetchFn }));
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "test-provider",
          target: "https://api.example.com/missing",
        },
      },
    });
    expect(res.status).toBe(200);
    const result = res.json.result as {
      isError?: boolean;
      _meta?: Record<string, unknown>;
    };
    // With propagation, a 404 surfaces as a tool-level error.
    expect(result.isError).toBe(true);
    const meta = result._meta!["appstrate/upstream"] as {
      status: number;
      headers: Record<string, string>;
    };
    expect(meta.status).toBe(404);
    expect(meta.headers["retry-after"]).toBe("30");
  });

  it("attaches upstream meta when response spills to BlobStore (binary)", async () => {
    // Even when content[] becomes a `resource_link` (binary spill),
    // the meta payload still ships so the agent can read upstream
    // status + headers without fetching the blob.
    const fetchFn = mock(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": "4",
            ETag: '"bin-abc"',
          },
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
    const result = res.json.result as {
      content: Array<{ type: string; uri?: string }>;
      _meta?: Record<string, unknown>;
    };
    expect(result.content[0]!.type).toBe("resource_link");
    const meta = result._meta!["appstrate/upstream"] as {
      status: number;
      headers: Record<string, string>;
    };
    expect(meta.status).toBe(200);
    expect(meta.headers.etag).toBe('"bin-abc"');
  });

  it("attaches sanitised finalUrl to _meta after a redirect chain (#471)", async () => {
    // End-to-end: agent triggers an OAuth-style flow via provider_call
    // and reads the terminal callback URL (with ?code=…) from
    // _meta["appstrate/upstream"].finalUrl — without having to parse
    // an empty/HTML body or rely on headers.location (which is the
    // *next* hop, undefined on terminal 200/4xx).
    const fetchFn = mock(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/authorize")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://api.example.com/login" },
        });
      }
      if (u.endsWith("/login")) {
        return new Response(null, {
          status: 302,
          headers: {
            // Userinfo + fragment included to prove sidecar sanitises.
            location: "https://user:secret@api.example.com/callback?code=ABC123#leaked",
          },
        });
      }
      return new Response("ok", { status: 200 });
    });
    const app = createApp(makeDeps({ fetchFn }));
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "test-provider",
          target: "https://api.example.com/authorize",
        },
      },
    });
    expect(res.status).toBe(200);
    const result = res.json.result as {
      _meta?: Record<string, unknown>;
    };
    const meta = result._meta!["appstrate/upstream"] as {
      status: number;
      finalUrl?: string;
    };
    expect(meta.status).toBe(200);
    expect(meta.finalUrl).toBe("https://api.example.com/callback?code=ABC123");
    // Defence-in-depth: userinfo + fragment never appear in the agent
    // context regardless of what the upstream Location header carried.
    expect(meta.finalUrl).not.toContain("user");
    expect(meta.finalUrl).not.toContain("secret");
    expect(meta.finalUrl).not.toContain("leaked");
    expect(meta.finalUrl).not.toContain("#");
  });

  it("does NOT attach finalUrl on preflight failure (no upstream contact)", async () => {
    const app = createApp(makeDeps());
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "test-provider",
          target: "https://not-allowed.example.com/x",
        },
      },
    });
    const result = res.json.result as {
      isError?: boolean;
      _meta?: Record<string, unknown>;
    };
    expect(result.isError).toBe(true);
    const meta = result._meta!["appstrate/upstream"] as {
      status: number;
      headers: Record<string, string>;
      finalUrl?: string;
    };
    expect(meta.status).toBe(0);
    expect(meta.finalUrl).toBeUndefined();
  });

  it("spills non-text upstream responses to a resource_link", async () => {
    // Binary upstream responses are stored in a run-scoped blob cache
    // and returned as a `resource_link` that the agent can read on
    // demand via `client.readResource({ uri })`.
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
    const result = res.json.result as {
      content: Array<{ type: string; uri?: string; mimeType?: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("resource_link");
    expect(result.content[0]!.uri).toMatch(
      /^appstrate:\/\/provider-response\/[A-Za-z0-9_-]+\/[A-Z0-9]{26}$/,
    );
    expect(result.content[0]!.mimeType).toBe("application/octet-stream");
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

describe("POST /mcp — per-request transport (stateless mode)", () => {
  // Regression: the SDK's WebStandardStreamableHTTPServerTransport
  // throws "Stateless transport cannot be reused across requests" on
  // the second invocation when constructed with
  // `sessionIdGenerator: undefined`. A previous implementation built the
  // transport once at mount time and shared it across requests, capping
  // the agent at exactly one MCP call per sidecar lifetime. These two
  // tests would have caught that bug — they exercise the simplest
  // (`tools/list`) and the most common (`tools/call`) JSON-RPC
  // exchanges back-to-back on the same Hono app.

  it("handles two consecutive tools/list calls on the same app", async () => {
    const app = createApp(makeDeps());

    const first = await rpc(app, { method: "tools/list" });
    expect(first.status).toBe(200);
    const firstResult = first.json.result as { tools: Array<{ name: string }> };
    expect(firstResult.tools.map((t) => t.name).sort()).toEqual([
      "provider_call",
      "recall_memory",
      "run_history",
    ]);

    const second = await rpc(app, { method: "tools/list" });
    expect(second.status).toBe(200);
    expect(second.json.error).toBeUndefined();
    const secondResult = second.json.result as { tools: Array<{ name: string }> };
    expect(secondResult.tools.map((t) => t.name).sort()).toEqual([
      "provider_call",
      "recall_memory",
      "run_history",
    ]);
  });

  it("handles two consecutive tools/call invocations on the same app", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"id":"abc"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn }));

    const args = {
      providerId: "test-provider",
      target: "https://api.example.com/items",
      method: "GET",
    };

    const first = await rpc(app, {
      method: "tools/call",
      params: { name: "provider_call", arguments: args },
    });
    expect(first.status).toBe(200);
    const firstResult = first.json.result as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(firstResult.isError).toBeUndefined();
    expect(firstResult.content[0]!.text).toBe('{"id":"abc"}');

    const second = await rpc(app, {
      method: "tools/call",
      params: { name: "provider_call", arguments: args },
    });
    expect(second.status).toBe(200);
    expect(second.json.error).toBeUndefined();
    const secondResult = second.json.result as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(secondResult.isError).toBeUndefined();
    expect(secondResult.content[0]!.text).toBe('{"id":"abc"}');

    // Both invocations reached the upstream — proves the second MCP
    // call did not fail at the transport layer before reaching the
    // credential-proxy core.
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("POST /mcp — provider_call body / method consistency", () => {
  it("returns isError: true when body is supplied with GET", async () => {
    const app = createApp(makeDeps());
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "test-provider",
          target: "https://api.example.com/items",
          method: "GET",
          body: '{"x":1}',
        },
      },
    });
    expect(res.status).toBe(200);
    const result = res.json.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("'body' is not allowed");
    expect(result.content[0]!.text).toContain("GET");
  });

  it("returns isError: true when body is supplied with HEAD", async () => {
    const app = createApp(makeDeps());
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "test-provider",
          target: "https://api.example.com/items",
          method: "HEAD",
          body: "anything",
        },
      },
    });
    const result = res.json.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("HEAD");
  });
});

describe("POST /mcp — provider_call binary body via { fromBytes }", () => {
  // The agent never sees the raw bytes — runtime resolvers materialise
  // workspace files (`{ fromFile }`) or in-memory buffers
  // (`{ fromBytes }`) into base64 before MCP because JSON-RPC has no
  // native byte type. The sidecar decodes once on the server side and
  // forwards the bytes byte-for-byte.

  function makeProviderDeps() {
    return makeDeps({
      fetchCredentials: mock(
        async (): Promise<CredentialsResponse> => ({
          credentials: { access_token: "tok" },
          authorizedUris: ["https://api.example.com/**"],
          allowAllUris: false,
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer",
          credentialFieldName: "access_token",
        }),
      ),
    });
  }

  it("decodes base64 body and forwards bytes verbatim to upstream", async () => {
    // Non-UTF-8 bytes — would be corrupted by the legacy text path.
    const binary = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const base64 = Buffer.from(binary).toString("base64");
    let received: ArrayBuffer | undefined;
    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      received = init?.body as ArrayBuffer | undefined;
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const app = createApp({ ...makeProviderDeps(), fetchFn: fetchFn as unknown as typeof fetch });

    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "@appstrate/test",
          target: "https://api.example.com/upload",
          method: "POST",
          body: { fromBytes: base64, encoding: "base64" },
        },
      },
    });
    expect(res.status).toBe(200);
    const result = res.json.result as { isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(received).toBeDefined();
    expect(new Uint8Array(received as ArrayBuffer)).toEqual(binary);
  });

  it("rejects body { fromBytes } with invalid base64", async () => {
    const app = createApp(makeProviderDeps());
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "@appstrate/test",
          target: "https://api.example.com/upload",
          method: "POST",
          body: { fromBytes: "not-base64!!!", encoding: "base64" },
        },
      },
    });
    const result = res.json.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not standard base64");
  });

  it("rejects body { fromBytes } over the per-request cap with structured error", async () => {
    // Build a payload just past MAX_REQUEST_BODY_SIZE. Use a small
    // overage so the test stays cheap; the inflated base64 must still
    // fit the MCP envelope cap (which is sized to accommodate this).
    const oversizeBytes = MAX_REQUEST_BODY_SIZE + 1024;
    const payload = Buffer.alloc(oversizeBytes, 0x42); // arbitrary filler
    const base64 = payload.toString("base64");
    const app = createApp(makeProviderDeps());
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "@appstrate/test",
          target: "https://api.example.com/upload",
          method: "POST",
          body: { fromBytes: base64, encoding: "base64" },
        },
      },
    });
    expect(res.status).toBe(200);
    const result = res.json.result as {
      content: Array<{ text: string }>;
      structuredContent?: {
        error?: {
          code?: string;
          scope?: string;
          limit?: number;
          actual?: number;
          envVar?: string;
        };
      };
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("exceeds the per-request limit");
    expect(result.structuredContent?.error?.code).toBe("PAYLOAD_TOO_LARGE");
    expect(result.structuredContent?.error?.scope).toBe("request_body");
    expect(result.structuredContent?.error?.limit).toBe(MAX_REQUEST_BODY_SIZE);
    expect(result.structuredContent?.error?.actual).toBe(oversizeBytes);
    expect(result.structuredContent?.error?.envVar).toBe("SIDECAR_MAX_REQUEST_BODY_BYTES");
  });

  it("rejects substituteBody: true when body is { fromBytes }", async () => {
    const app = createApp(makeProviderDeps());
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "@appstrate/test",
          target: "https://api.example.com/upload",
          method: "POST",
          body: { fromBytes: Buffer.from("hi").toString("base64"), encoding: "base64" },
          substituteBody: true,
        },
      },
    });
    const result = res.json.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("substituteBody requires a text body");
  });
});

describe("POST /mcp — caller cannot forge sidecar control headers", () => {
  // Regression: the MCP descriptor advertises that routing /
  // sidecar-control headers are filtered server-side. An earlier
  // version of `mcp.ts` spread `args.headers` BEFORE the controlled
  // overrides, so an LLM supplying e.g. `X-Stream-Response: 1` could
  // opt into the binary streaming path the MCP layer is explicitly
  // designed not to expose, or `X-Substitute-Body: 1` to inject
  // {{credential}} placeholders into an attacker-controlled payload.

  for (const forbidden of [
    "X-Stream-Response",
    "X-Substitute-Body",
    "X-Max-Response-Size",
    "X-Provider",
    "X-Target",
  ]) {
    it(`rejects ${forbidden} supplied via args.headers`, async () => {
      const fetchFn = mock(
        async () =>
          new Response('{"ok":true}', {
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
            headers: { [forbidden]: "1" },
          },
        },
      });

      expect(res.status).toBe(200);
      const result = res.json.result as { content: Array<{ text: string }>; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("sidecar-control names");
      expect(result.content[0]!.text).toContain(forbidden);

      // The forbidden header must NOT have reached the upstream — the
      // request is rejected before executeProviderCall is invoked.
      // fetchFn is the upstream stub on the far side of the credential
      // proxy, so it must not have been called at all.
      expect(fetchFn).not.toHaveBeenCalled();
    });
  }

  it("matches forbidden header names case-insensitively", async () => {
    const app = createApp(makeDeps());
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "test-provider",
          target: "https://api.example.com/items",
          // HTTP header semantics are case-insensitive — bypass via
          // case variation must not work.
          headers: { "x-stream-response": "1" },
        },
      },
    });
    const result = res.json.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("sidecar-control names");
  });

  it("preserves benign caller-supplied headers", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"ok":true}', {
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
          headers: { "X-Custom-Trace": "abc" },
        },
      },
    });
    // The forbidden-name filter must let benign headers through to
    // the credential-proxy core without producing a tool-level error.
    // executeProviderCall further strips hop-by-hop headers before
    // hitting the upstream — that's the credential proxy's concern,
    // not the MCP layer's. The contract here is "benign headers don't
    // get rejected by the MCP filter".
    const result = res.json.result as { isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("POST /mcp — request body size cap", () => {
  // Regression: the SDK's WebStandardStreamableHTTPServerTransport
  // calls `await req.json()` on POST without any size limit. From the
  // sidecar's threat model, the agent container is the untrusted side
  // of the bridge, so a runaway agent could OOM the sidecar with a
  // multi-GB JSON-RPC envelope.

  it("rejects requests whose declared Content-Length exceeds the cap", async () => {
    const app = createApp(makeDeps());
    // We don't send the actual oversize body — the declared length
    // alone must be sufficient to reject.
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Content-Length": String(MAX_MCP_ENVELOPE_SIZE + 1),
        Host: "localhost",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(413);
    const json = (await res.json()) as {
      error: {
        message: string;
        data?: {
          reason?: string;
          scope?: string;
          limit?: number;
          actual?: number;
          envVar?: string;
          hint?: string;
        };
      };
    };
    expect(json.error.message).toContain("exceeds");
    // Structured error payload — agents can act on these fields without
    // parsing the prose `message`.
    expect(json.error.data?.reason).toBe("PAYLOAD_TOO_LARGE");
    expect(json.error.data?.scope).toBe("mcp_envelope");
    expect(json.error.data?.limit).toBe(MAX_MCP_ENVELOPE_SIZE);
    expect(json.error.data?.actual).toBe(MAX_MCP_ENVELOPE_SIZE + 1);
    expect(json.error.data?.envVar).toBe("SIDECAR_MAX_MCP_ENVELOPE_BYTES");
    expect(json.error.data?.hint).toContain("base64");
  });

  it("rejects requests whose streamed body exceeds the cap", async () => {
    const app = createApp(makeDeps());
    // Build an oversized body without a declared Content-Length so the
    // streaming path is exercised. Pad just past the envelope cap.
    const giant = "x".repeat(MAX_MCP_ENVELOPE_SIZE + 1024);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "run_history", arguments: { padding: giant } },
    });
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Host: "localhost",
      },
      body,
    });
    expect(res.status).toBe(413);
    const json = (await res.json()) as {
      error: { data?: { scope?: string; limit?: number } };
    };
    expect(json.error.data?.scope).toBe("mcp_envelope");
    expect(json.error.data?.limit).toBe(MAX_MCP_ENVELOPE_SIZE);
  });

  it("accepts a small request just under the cap", async () => {
    const app = createApp(makeDeps());
    const res = await rpc(app, { method: "tools/list" });
    expect(res.status).toBe(200);
    expect(res.json.error).toBeUndefined();
  });
});

describe("POST /mcp — bounded response read", () => {
  // `responseToToolResult` reads upstream bodies via a bounded
  // streaming reader so an oversized upstream response (e.g. from
  // `run_history`'s platform passthrough) cannot blow the agent's
  // memory or context window even when no upstream-side cap fires
  // first. Defence-in-depth.

  it("spills oversized upstream responses to the blob store as a resource_link", async () => {
    const oversized = "y".repeat(512 * 1024); // 512 KB → far above any inline budget
    const fetchFn = mock(
      async () =>
        new Response(oversized, {
          status: 200,
          // Hit `run_history`, mocked to return the oversized body
          // directly. With the token-budget guard wired into
          // run_history, the response should spill to the blob store
          // rather than poison the agent's context.
          headers: { "Content-Type": "application/json" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn }));
    const res = await rpc(app, {
      method: "tools/call",
      params: { name: "run_history", arguments: { limit: 1 } },
    });
    const result = res.json.result as {
      content: Array<{ type: string; uri?: string; text?: string }>;
    };
    // The token-budget gate must have triggered the blob spill.
    expect(result.content[0]!.type).toBe("resource_link");
    expect(result.content[0]!.uri).toMatch(/^appstrate:\/\/provider-response\//);
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

describe("POST /mcp — provider_call concurrency cap (issue #427)", () => {
  // Regression: without a fan-out cap, an agent that issues N parallel
  // `provider_call`s funnels their full payloads into the next LLM turn
  // and blows past the upstream model's TPM window. The sidecar caps
  // simultaneous upstream hops via `SIDECAR_PROVIDER_CALL_CONCURRENCY`
  // (default 3). This test sets the cap to 2 and verifies that the 3rd
  // and 4th calls park until earlier permits release.

  it("limits concurrent upstream hops to SIDECAR_PROVIDER_CALL_CONCURRENCY", async () => {
    process.env.SIDECAR_PROVIDER_CALL_CONCURRENCY = "2";
    try {
      let active = 0;
      let peak = 0;
      // Each upstream fetch parks until the test releases it. We track
      // the peak simultaneous in-flight count: if the cap holds, peak
      // never exceeds 2 across 4 parallel `provider_call` invocations.
      const gates: Array<() => void> = [];
      const fetchFn = mock(async () => {
        active++;
        if (active > peak) peak = active;
        await new Promise<void>((resolve) => gates.push(resolve));
        active--;
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      const app = createApp(makeDeps({ fetchFn }));

      const issue = (id: number) =>
        rpc(app, {
          method: "tools/call",
          params: {
            name: "provider_call",
            arguments: {
              providerId: "test-provider",
              target: `https://api.example.com/items/${id}`,
              method: "GET",
            },
          },
        });

      const calls = Promise.all([issue(1), issue(2), issue(3), issue(4)]);

      // Yield the event loop enough times for the semaphore queue to
      // settle. We need the first 2 calls to have reached `fetchFn` —
      // 50 microtask turns is generous for the JSON-RPC + MCP plumbing.
      for (let i = 0; i < 50; i++) await Promise.resolve();
      expect(active).toBeLessThanOrEqual(2);
      expect(peak).toBeLessThanOrEqual(2);
      expect(gates.length).toBe(2);

      // Release one permit — exactly one more upstream call should
      // immediately start. Peak must still be capped at 2.
      gates.shift()!();
      for (let i = 0; i < 50; i++) await Promise.resolve();
      expect(peak).toBeLessThanOrEqual(2);

      // Release the rest so the test can wind down.
      while (gates.length > 0) {
        gates.shift()!();
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }

      const results = await calls;
      // All four calls eventually succeed.
      expect(results).toHaveLength(4);
      for (const r of results) {
        const result = r.json.result as { isError?: boolean };
        expect(result.isError).toBeUndefined();
      }
      // Cap held throughout the whole test, not just at the start.
      expect(peak).toBeLessThanOrEqual(2);
    } finally {
      delete process.env.SIDECAR_PROVIDER_CALL_CONCURRENCY;
    }
  });
});
