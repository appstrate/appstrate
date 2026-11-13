// SPDX-License-Identifier: Apache-2.0

/**
 * MCP endpoint integration tests.
 *
 * The sidecar mounts `/mcp` and serves the tools of its provider: every
 * integration tool, including a generic `{ns}__api_call` tool per
 * integration that opted into `apiCall`. These tests verify wire-format compliance and the auth / authorisation /
 * SSRF guarantees that the MCP path enforces end-to-end.
 */

import { describe, it, expect, jest, mock } from "bun:test";
import { PROXY_INJECTED_FIELD } from "@appstrate/connect/integration-credentials";
import { buildSidecarRuntimeDeps, type AppDeps } from "../app.ts";
import { createTestApp } from "./helpers/authed-app.ts";
import { buildApiCallHost } from "./helpers/api-call-host.ts";
import { MAX_MCP_ENVELOPE_SIZE } from "../helpers.ts";
import { McpHost } from "../mcp-host.ts";
import {
  createInProcessPair,
  createMcpHttpClient,
  wrapClient,
  type AppstrateToolDefinition,
} from "@appstrate/mcp-transport";

/** A tool answering its own arguments as JSON text. */
const echoTool: AppstrateToolDefinition = {
  descriptor: { name: "echo", inputSchema: { type: "object" } },
  handler: async (args) => ({ content: [{ type: "text", text: JSON.stringify(args) }] }),
};

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
    mcpToolsProvider: () => [echoTool],
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
  // The sidecar answers JSON unless the request carries a progressToken
  // (then SSE); these requests carry none, so the body is one JSON-RPC envelope.
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
  it("advertises the tools of its provider", async () => {
    const app = createTestApp(makeDeps());
    const res = await rpc(app, { method: "tools/list" });
    expect(res.status).toBe(200);
    const result = res.json.result as { tools: Array<{ name: string }> };
    expect(result.tools.map((t) => t.name)).toEqual(["echo"]);
  });

  it("serves no tools, rather than failing, when a descriptor is malformed", async () => {
    const malformed: AppstrateToolDefinition = {
      ...echoTool,
      descriptor: { name: "not a valid name!", inputSchema: { type: "object" } },
    };
    const app = createTestApp(makeDeps({ mcpToolsProvider: () => [echoTool, malformed] }));
    const res = await rpc(app, { method: "tools/list" });
    expect(res.status).toBe(200);
    expect((res.json.result as { tools: unknown[] }).tools).toEqual([]);
  });
});

describe("POST /mcp — answer format", () => {
  async function callEcho(meta?: Record<string, unknown>): Promise<Response> {
    const app = createTestApp(makeDeps());
    return app.request("/mcp", {
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
        params: { name: "echo", arguments: {}, ...(meta ? { _meta: meta } : {}) },
      }),
    });
  }

  it("answers JSON when the call asks for no progress", async () => {
    const res = await callEcho();
    expect(res.headers.get("content-type")).toStartWith("application/json");
    expect(((await res.json()) as { id: number }).id).toBe(1);
  });

  it("streams over SSE, opened at once, when the call carries a progressToken", async () => {
    const res = await callEcho({ progressToken: "agent_tok" });
    expect(res.headers.get("content-type")).toStartWith("text/event-stream");
    const text = await res.text();
    // The open comment first, then the result frame: the server lived until the
    // tool answered, it was not torn down when the response was returned.
    expect(text.startsWith(": stream open\n\n")).toBe(true);
    const frame = text.split("\n").find((line) => line.startsWith("data: "));
    expect(JSON.parse(frame!.slice("data: ".length))).toMatchObject({ id: 1, result: {} });
  });
});

describe("GET /mcp", () => {
  it("is answered and closed at once, not held open for the run", async () => {
    const app = createTestApp(makeDeps());
    const res = await app.request("/mcp", {
      method: "GET",
      headers: { Accept: "text/event-stream", Host: "localhost" },
    });
    const drained = await Promise.race([
      res.text().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    expect(drained).toBe(true);
  });
});

describe("/mcp — progress relay over SSE, end to end", () => {
  it("delivers an upstream's progress to an agent client that asked for it, throttled", async () => {
    // Fake timers hold every macrotask: the in-process hops settle on microtasks.
    const settle = async () => {
      for (let i = 0; i < 50; i++) await Promise.resolve();
    };
    // Upstream integration: reports progress under whatever token it receives.
    const upstream = await createInProcessPair([
      {
        descriptor: { name: "long", inputSchema: { type: "object" } },
        handler: async (_args, extra) => {
          const progressToken = extra._meta?.progressToken;
          if (progressToken !== undefined) {
            const report = (progress: number) =>
              extra.sendNotification({
                method: "notifications/progress",
                params: { progressToken, progress, message: `step ${progress}` },
              });
            await report(1);
            await report(2);
            await report(3);
            await settle();
            jest.advanceTimersByTime(1000);
            // Still inside the window when the call answers: never relayed.
            await report(4);
            await settle();
          }
          return { content: [{ type: "text", text: "done" }] };
        },
      },
    ]);
    const host = new McpHost();
    await host.register({
      connection: { label: "work", accountId: null },
      namespace: "up",
      client: wrapClient(upstream.client, { close: () => Promise.resolve() }),
    });
    const app = createTestApp({
      ...makeDeps(),
      mcpToolsProvider: () => host.buildTools(),
    });
    // The agent's real HTTP client, routed into the in-process app.
    const agent = await createMcpHttpClient("http://localhost/mcp", {
      fetch: ((input: URL | Request | string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set("Host", "localhost");
        return app.request(new URL(String(input)).pathname, { ...init, headers });
      }) as typeof fetch,
    });
    try {
      const received: unknown[] = [];
      jest.useFakeTimers();
      const result = await agent.callTool(
        { name: "up__long" },
        { onProgress: (p) => received.push(p) },
      );
      expect(result.content).toEqual([{ type: "text", text: "done" }]);
      // The first at once, the latest of the window when it ends.
      expect(received).toEqual([
        { progress: 1, message: "step 1" },
        { progress: 3, message: "step 3" },
      ]);
    } finally {
      jest.useRealTimers();
      await agent.close();
      await upstream.close();
    }
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
    expect(firstResult.tools.map((t) => t.name)).toEqual(["echo"]);

    const second = await rpc(app, { method: "tools/list" });
    expect(second.status).toBe(200);
    expect(second.json.error).toBeUndefined();
    const secondResult = second.json.result as { tools: Array<{ name: string }> };
    expect(secondResult.tools.map((t) => t.name)).toEqual(["echo"]);
  });

  it("handles two consecutive tools/call invocations on the same app", async () => {
    const app = createTestApp(makeDeps());

    for (let call = 0; call < 2; call++) {
      const res = await rpc(app, {
        method: "tools/call",
        params: { name: "echo", arguments: { call } },
      });
      expect(res.status).toBe(200);
      expect(res.json.error).toBeUndefined();
      const result = res.json.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.text).toBe(JSON.stringify({ call }));
    }
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
      params: { name: "echo", arguments: { padding: giant } },
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

describe("POST /mcp — api_call", () => {
  const integrationCreds = (token = "integ-tok-1") => ({
    credentials: { [PROXY_INJECTED_FIELD]: token },
    authorizedUris: ["https://api.example.com/**"],
    allowAllUris: false,
    credentialHeaderName: "Authorization",
    credentialHeaderPrefix: "Bearer ",
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
          connectionId: "conn-1",
          declaredUris: ["https://api.example.com/**"],
          fetchCredentials: async () => integrationCreds(),
          refreshCredentials: async () => integrationCreds("integ-tok-2"),
        },
      ],
      runtimeDeps,
    );
    return createTestApp({
      ...appDeps,
      runtimeDeps,
      mcpToolsProvider: () => host.buildTools(),
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
        arguments: { target: "https://api.example.com/v1/messages", method: "GET" },
      },
    });
    expect(res.status).toBe(200);
    const result = res.json.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe('{"messages":[]}');
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer integ-tok-1");
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
    expect(result.content[0]!.text).toContain("not in authorized_uris allowlist");
  });

  it("registers no api_call tool when no integration opts in", async () => {
    const app = createTestApp(makeDeps());
    const res = await rpc(app, { method: "tools/list" });
    const result = res.json.result as { tools: Array<{ name: string }> };
    expect(result.tools.some((t) => t.name.endsWith("__api_call"))).toBe(false);
  });
});
