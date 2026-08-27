// SPDX-License-Identifier: Apache-2.0

/**
 * MCP endpoint integration tests.
 *
 * The sidecar mounts `/mcp` and exposes `run_history` and
 * `recall_memory` as first-party MCP tools, plus a generic
 * `{ns}__api_call` tool per integration that opted into `apiCall`. These
 * tests verify wire-format compliance and the auth / authorisation /
 * SSRF guarantees that the MCP path enforces end-to-end.
 */

import { describe, it, expect, jest, mock } from "bun:test";
import { PROXY_INJECTED_FIELD } from "@appstrate/connect/integration-credentials";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildSidecarRuntimeDeps, type AppDeps } from "../app.ts";
import { createTestApp } from "./helpers/authed-app.ts";
import { buildApiCallHost } from "./helpers/api-call-host.ts";
import { MAX_MCP_ENVELOPE_SIZE } from "../helpers.ts";

function makeDeps(overrides?: Partial<AppDeps>): AppDeps {
  return {
    config: { platformApiUrl: "http://mock:3000", runToken: "tok", proxyUrl: "" },
    cookieJar: new Map(),
    // Bun's `Mock` lacks the `preconnect` member that `typeof fetch`
    // declares; the cast bridges that cross-lib friction.
    fetchFn: mock(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch,
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
  app: ReturnType<typeof createTestApp>,
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

  function rawMcp(app: ReturnType<typeof createTestApp>, host: string | null) {
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
    const res = await rawMcp(createTestApp(makeDeps()), "sidecar:8080");
    expect(res.status).toBe(200);
  });

  it("accepts localhost with a dynamic port (process orchestrator)", async () => {
    const res = await rawMcp(createTestApp(makeDeps()), "localhost:51123");
    expect(res.status).toBe(200);
  });

  it("accepts 127.0.0.1 with a dynamic port", async () => {
    const res = await rawMcp(createTestApp(makeDeps()), "127.0.0.1:62000");
    expect(res.status).toBe(200);
  });

  it("accepts portless hostnames (Hono test default)", async () => {
    const res = await rawMcp(createTestApp(makeDeps()), "localhost");
    expect(res.status).toBe(200);
  });

  it("rejects unknown hosts with 403 + JSON-RPC error envelope", async () => {
    const res = await rawMcp(createTestApp(makeDeps()), "evil.example.com:8080");
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
    const res = await rawMcp(createTestApp(makeDeps()), "notlocalhost:8080");
    expect(res.status).toBe(403);
  });

  it("rejects a missing Host header", async () => {
    // `app.request()` won't send a Host header unless we set one
    // explicitly. The validator must fail closed in that case.
    const res = await rawMcp(createTestApp(makeDeps()), null);
    expect(res.status).toBe(403);
  });
});

describe("POST /mcp — initialize", () => {
  it("returns server capabilities advertising tools support", async () => {
    const app = createTestApp(makeDeps());
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
  it("advertises run_history and recall_memory (no api_call)", async () => {
    const app = createTestApp(makeDeps());
    const res = await rpc(app, { method: "tools/list" });
    expect(res.status).toBe(200);
    const result = res.json.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["recall_memory", "run_history"]);
  });

  it("declares input schemas matching the legacy contracts", async () => {
    const app = createTestApp(makeDeps());
    const res = await rpc(app, { method: "tools/list" });
    const result = res.json.result as {
      tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
    };
    const history = result.tools.find((t) => t.name === "run_history")!;
    expect(Object.keys(history.inputSchema.properties).sort()).toEqual(["fields", "limit"]);
    const recall = result.tools.find((t) => t.name === "recall_memory")!;
    expect(Object.keys(recall.inputSchema.properties).sort()).toEqual(["limit", "q"]);
  });

  // Regression — the agent-facing `run_history.fields` enum is the LLM's
  // single source of truth for the wire vocabulary. If the legacy `state`
  // value re-appears here, agents start sending it again and the platform
  // 400s every call. Lock it to the canonical AFPS values.
  it("advertises run_history.fields as exactly [checkpoint, result]", async () => {
    const app = createTestApp(makeDeps());
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
    const app = createTestApp(makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }));

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
    const calledUrl = (fetchFn.mock.calls[0] as unknown as [string])[0];
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
    const app = createTestApp(makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }));

    const res = await rpc(app, {
      method: "tools/call",
      params: { name: "recall_memory", arguments: { q: "python", limit: 3 } },
    });
    expect(res.status).toBe(200);
    const result = res.json.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe('{"memories":[{"id":1,"content":"x"}]}');

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const calledUrl = (fetchFn.mock.calls[0] as unknown as [string])[0];
    expect(calledUrl).toContain("/internal/memories");
    expect(calledUrl).toContain("q=python");
    expect(calledUrl).toContain("limit=3");
  });

  it("omits empty q from the upstream URL", async () => {
    const fetchFn = mock(async () => new Response('{"memories":[]}', { status: 200 }));
    const app = createTestApp(makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }));

    await rpc(app, {
      method: "tools/call",
      params: { name: "recall_memory", arguments: { limit: 1 } },
    });
    const calledUrl = (fetchFn.mock.calls[0] as unknown as [string])[0];
    expect(calledUrl).not.toContain("q=");
    expect(calledUrl).toContain("limit=1");
  });
});

describe("POST /mcp — protocol errors", () => {
  it("returns -32601 MethodNotFound for unsupported methods", async () => {
    const app = createTestApp(makeDeps());
    const res = await rpc(app, { method: "sampling/createMessage" });
    expect(res.status).toBe(200);
    const error = res.json.error as { code: number };
    expect(error.code).toBe(-32601);
  });

  it("rejects unknown tool names with InvalidParams (spec-canonical -32602)", async () => {
    const app = createTestApp(makeDeps());
    const res = await rpc(app, {
      method: "tools/call",
      params: { name: "totally-not-a-tool" },
    });
    const error = res.json.error as { code: number; message: string };
    expect(error.code).toBe(-32602);
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
    const app = createTestApp(makeDeps());

    const first = await rpc(app, { method: "tools/list" });
    expect(first.status).toBe(200);
    const firstResult = first.json.result as { tools: Array<{ name: string }> };
    expect(firstResult.tools.map((t) => t.name).sort()).toEqual(["recall_memory", "run_history"]);

    const second = await rpc(app, { method: "tools/list" });
    expect(second.status).toBe(200);
    expect(second.json.error).toBeUndefined();
    const secondResult = second.json.result as { tools: Array<{ name: string }> };
    expect(secondResult.tools.map((t) => t.name).sort()).toEqual(["recall_memory", "run_history"]);
  });

  it("handles two consecutive tools/call invocations on the same app", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"id":"abc"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const app = createTestApp(makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }));

    const args = { limit: 1 };

    const first = await rpc(app, {
      method: "tools/call",
      params: { name: "run_history", arguments: args },
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
      params: { name: "run_history", arguments: args },
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

describe("POST /mcp — request body size cap", () => {
  // Regression: the SDK's WebStandardStreamableHTTPServerTransport
  // calls `await req.json()` on POST without any size limit. From the
  // sidecar's threat model, the agent container is the untrusted side
  // of the bridge, so a runaway agent could OOM the sidecar with a
  // multi-GB JSON-RPC envelope.

  it("rejects requests whose declared Content-Length exceeds the cap", async () => {
    const app = createTestApp(makeDeps());
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
    const app = createTestApp(makeDeps());
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
    const app = createTestApp(makeDeps());
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
    const app = createTestApp(makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }));
    const res = await rpc(app, {
      method: "tools/call",
      params: { name: "run_history", arguments: { limit: 1 } },
    });
    const result = res.json.result as {
      content: Array<{ type: string; uri?: string; text?: string }>;
    };
    // The token-budget gate must have triggered the blob spill.
    expect(result.content[0]!.type).toBe("resource_link");
    expect(result.content[0]!.uri).toMatch(/^appstrate:\/\/api-response\//);
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

describe("POST /mcp — api_call", () => {
  const integrationCreds = (token = "integ-tok-1") => ({
    credentials: { [PROXY_INJECTED_FIELD]: token },
    authorizedUris: ["https://gmail.googleapis.com/**"],
    allowAllUris: false,
    credentialHeaderName: "Authorization",
    credentialHeaderPrefix: "Bearer",
    credentialFieldName: PROXY_INJECTED_FIELD,
  });

  async function makeApiCallApp(overrides?: Partial<AppDeps>) {
    const appDeps = makeDeps(overrides);
    const runtimeDeps = buildSidecarRuntimeDeps(appDeps);
    const host = await buildApiCallHost(
      [
        {
          namespace: "gmail",
          integrationId: "@official/gmail",
          fetchCredentials: async () => integrationCreds(),
          refreshCredentials: async () => integrationCreds("integ-tok-2"),
        },
      ],
      runtimeDeps,
    );
    return createTestApp({
      ...appDeps,
      runtimeDeps,
      additionalMcpToolsProvider: () => host.buildTools(),
    });
  }

  it("advertises {namespace}__api_call in tools/list", async () => {
    const app = await makeApiCallApp();
    const res = await rpc(app, { method: "tools/list" });
    const result = res.json.result as {
      tools: Array<{
        name: string;
        inputSchema: { properties: Record<string, unknown>; required?: string[] };
      }>;
    };
    const apiCall = result.tools.find((t) => t.name === "gmail__api_call");
    expect(apiCall).toBeDefined();
    // The cloned descriptor drops `integrationId` — the integration is implied.
    expect(apiCall!.inputSchema.properties.integrationId).toBeUndefined();
    expect(apiCall!.inputSchema.required ?? []).not.toContain("integrationId");
    expect(apiCall!.inputSchema.required ?? []).toContain("target");
  });

  it("injects the integration credential and forwards upstream", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"messages":[]}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const app = await makeApiCallApp({ fetchFn: fetchFn as unknown as typeof fetch });
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "gmail__api_call",
        arguments: { target: "https://gmail.googleapis.com/v1/messages", method: "GET" },
      },
    });
    expect(res.status).toBe(200);
    const result = res.json.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe('{"messages":[]}');
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer integ-tok-1");
  });

  it("enforces the integration authorizedUris allowlist", async () => {
    const app = await makeApiCallApp();
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "gmail__api_call",
        arguments: { target: "https://evil.example.com/exfil", method: "GET" },
      },
    });
    const result = res.json.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not authorized");
  });

  it("registers no api_call tool when no integration opts in", async () => {
    const app = createTestApp(makeDeps());
    const res = await rpc(app, { method: "tools/list" });
    const result = res.json.result as { tools: Array<{ name: string }> };
    expect(result.tools.some((t) => t.name.endsWith("__api_call"))).toBe(false);
  });
});

/**
 * The deadline on the two first-party platform calls.
 *
 * `run_history` and `recall_memory` are the sidecar's only calls out to the
 * platform, and `/mcp` has no server-side deadline of its own: a platform that
 * accepts the connection and never answers would hang the agent's tool call —
 * and the agent with it — for the rest of the run. `OUTBOUND_TIMEOUT_MS` is
 * the same 30 s bound every other outbound call in the sidecar carries.
 *
 * Fake timers, not real sleeps: a suite that actually waits 30 s is not worth
 * having. Bun's fake timers drive `AbortSignal.timeout` too.
 */
describe("POST /mcp — first-party platform calls are deadline-bounded", () => {
  /** Let the in-flight request chain advance without any wall-clock wait. */
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  }

  /** A platform that accepts the call and never answers, ending only on abort. */
  function hangingFetch(signals: AbortSignal[]): typeof fetch {
    return (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal;
      if (!signal) throw new Error("platform call carried no AbortSignal — it can hang forever");
      signals.push(signal);
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as unknown as typeof fetch;
  }

  for (const [tool, args] of [
    ["run_history", { limit: 5 }],
    ["recall_memory", { q: "python" }],
  ] as const) {
    it(`${tool} gives up when the platform never answers`, async () => {
      jest.useFakeTimers();
      try {
        const signals: AbortSignal[] = [];
        const app = createTestApp(makeDeps({ fetchFn: hangingFetch(signals) }));
        const pending = rpc(app, { method: "tools/call", params: { name: tool, arguments: args } });

        await flushMicrotasks();
        expect(signals).toHaveLength(1);
        // One second short of the bound, the call is still waiting — the
        // deadline is the 30 s one, not an accidental shorter cancel.
        jest.advanceTimersByTime(29_000);
        await flushMicrotasks();
        expect(signals[0]!.aborted).toBe(false);

        jest.advanceTimersByTime(2_000);
        await flushMicrotasks();

        const res = await pending;
        expect((signals[0]!.reason as Error).name).toBe("TimeoutError");
        const result = res.json.result as { content: Array<{ text: string }>; isError?: boolean };
        // A tool-level error the agent can read and retry — not a hung call.
        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toBe(`${tool}: upstream fetch timed out after 30000ms`);
      } finally {
        jest.useRealTimers();
      }
    });

    // Control: same tool, same clock, against a platform that answers. If the
    // composed signal broke the call outright, or the deadline fired on a
    // finished request, this fails — so the test above cannot pass by way of a
    // wholly broken path.
    it(`${tool} still returns the upstream body when the platform answers`, async () => {
      jest.useFakeTimers();
      try {
        // Sampled at call time. Reading it afterwards would say nothing: the
        // SDK aborts the MCP request's own signal once the response is
        // written, and that signal is one leg of the composed one — which is
        // precisely why the deadline is composed WITH it rather than replacing
        // it.
        let armedNotFired: boolean | undefined;
        const fetchFn = (async (
          _input: string | URL | Request,
          init?: RequestInit,
        ): Promise<Response> => {
          armedNotFired = init?.signal != null && !init.signal.aborted;
          return new Response('{"ok":true}', {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }) as unknown as typeof fetch;
        const app = createTestApp(makeDeps({ fetchFn }));

        const res = await rpc(app, {
          method: "tools/call",
          params: { name: tool, arguments: args },
        });

        const result = res.json.result as { content: Array<{ text: string }>; isError?: boolean };
        expect(result.isError).toBeUndefined();
        expect(result.content[0]!.text).toBe('{"ok":true}');
        // The bound was armed and simply never reached.
        expect(armedNotFired).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });
  }
});
