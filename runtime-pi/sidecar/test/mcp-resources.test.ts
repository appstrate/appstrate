// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the Phase 3a additions to the sidecar's `/mcp` endpoint:
 *   - `llm_complete` MCP tool wrapping `/llm/*`.
 *   - `resources/list` + `resources/read` backed by the run-scoped blob cache.
 *   - `provider_call` spilling oversized / binary upstream responses to
 *     resource_link blocks.
 *
 * The tests reuse the same `rpc()` JSON-RPC helper pattern as
 * `mcp.test.ts` to keep the wire contract honest.
 */

import { describe, it, expect, mock } from "bun:test";
import { createApp, type AppDeps } from "../app.ts";
import { type CredentialsResponse } from "../helpers.ts";

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    config: {
      platformApiUrl: "http://localhost:3000",
      runToken: "test-token",
      proxyUrl: "",
      llm: {
        baseUrl: "https://llm.example.com",
        apiKey: "real-key",
        placeholder: "sk-placeholder",
      },
    },
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
    isReady: () => true,
    fetchFn: mock(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch,
    runId: "run-test",
    ...overrides,
  };
}

async function rpc(
  app: ReturnType<typeof createApp>,
  payload: { method: string; params?: Record<string, unknown>; id?: number },
): Promise<{
  status: number;
  json: { result?: unknown; error?: { code: number; message: string } };
}> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      // The sidecar's DNS-rebinding guard requires a recognised Host;
      // Hono's in-process app.request() does not synthesise one.
      Host: "localhost",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: payload.method,
      ...(payload.params !== undefined ? { params: payload.params } : {}),
      id: payload.id ?? 1,
    }),
  });
  return {
    status: res.status,
    json: (await res.json()) as { result?: unknown; error?: { code: number; message: string } },
  };
}

describe("POST /mcp — llm_complete tool", () => {
  it("is advertised in tools/list with the documented input schema", async () => {
    const app = createApp(makeDeps());
    const res = await rpc(app, { method: "tools/list" });
    const result = res.json.result as {
      tools: Array<{
        name: string;
        inputSchema: { properties: Record<string, unknown>; required: string[] };
      }>;
    };
    const tool = result.tools.find((t) => t.name === "llm_complete");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toEqual(["path", "body"]);
    expect(tool!.inputSchema.properties).toHaveProperty("path");
    expect(tool!.inputSchema.properties).toHaveProperty("body");
    expect(tool!.inputSchema.properties).toHaveProperty("method");
    expect(tool!.inputSchema.properties).toHaveProperty("headers");
  });

  it("forwards POST /v1/messages to the upstream LLM with placeholder substitution", async () => {
    let observedUrl: string | null = null;
    let observedAuth: string | null = null;
    let observedBody: string | null = null;
    const fetchFn = mock(async (url: string, init: RequestInit) => {
      observedUrl = url;
      // After the MCP migration the llm_complete tool calls fetch
      // directly (no Hono round-trip), so caller-supplied header
      // casing is preserved. Read with the same case the test sends.
      const hdrs = init.headers as Record<string, string>;
      observedAuth = hdrs?.["Authorization"] ?? hdrs?.["authorization"] ?? null;
      if (typeof init.body === "string") {
        observedBody = init.body;
      } else if (init.body && typeof (init.body as ReadableStream).getReader === "function") {
        const reader = (init.body as ReadableStream<Uint8Array>).getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.byteLength;
        }
        observedBody = new TextDecoder().decode(merged);
      }
      return new Response('{"completion":"hi"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const app = createApp(
      makeDeps({
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    );
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "llm_complete",
        arguments: {
          path: "/v1/messages",
          body: '{"model":"claude-sonnet-4","messages":[]}',
          headers: { Authorization: "Bearer sk-placeholder" },
        },
      },
    });
    const result = res.json.result as { content: Array<{ type: string; text?: string }> };
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toBe('{"completion":"hi"}');
    expect(observedUrl).toBe("https://llm.example.com/v1/messages");
    expect(observedAuth).toBe("Bearer real-key");
    expect(observedBody).toBe('{"model":"claude-sonnet-4","messages":[]}');
  });

  it("rejects path traversal attempts in the path argument", async () => {
    const app = createApp(makeDeps());
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "llm_complete",
        arguments: { path: "/../../etc/passwd", body: "{}" },
      },
    });
    const result = res.json.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/invalid path/);
  });

  it("returns isError: true when LLM proxy is not configured", async () => {
    const deps = makeDeps();
    delete (deps.config as { llm?: unknown }).llm;
    const app = createApp(deps);
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "llm_complete",
        arguments: { path: "/v1/messages", body: "{}" },
      },
    });
    const result = res.json.result as { content: Array<{ text: string }>; isError: boolean };
    // The /llm/* route returns 503 when LLM not configured; the MCP
    // layer surfaces that as a tool-level error.
    expect(result.isError).toBe(true);
  });
});

describe("POST /mcp — provider_call resource spillover", () => {
  it("returns a resource_link block for binary upstream responses", async () => {
    const fetchFn = mock(
      async () =>
        new Response(new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }));
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "test-provider",
          target: "https://api.example.com/document.pdf",
        },
      },
    });
    const result = res.json.result as {
      content: Array<{ type: string; uri?: string; mimeType?: string; name?: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("resource_link");
    expect(result.content[0]!.mimeType).toBe("application/pdf");
    expect(result.content[0]!.uri).toMatch(
      /^appstrate:\/\/provider-response\/run-test\/[A-Z0-9]{26}$/,
    );
  });

  it("spills oversized text responses to a resource_link", async () => {
    // Generate a JSON body well above the 32 KB inline threshold.
    const big = JSON.stringify({ data: "x".repeat(40 * 1024) });
    const fetchFn = mock(
      async () =>
        new Response(big, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }));
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "test-provider",
          target: "https://api.example.com/large.json",
        },
      },
    });
    const result = res.json.result as {
      content: Array<{ type: string; uri?: string; mimeType?: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.type).toBe("resource_link");
    expect(result.content[0]!.mimeType).toContain("json");
  });

  it("inlines small text responses as before (no behaviour change for typical traffic)", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"ok":true,"size":"small"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }));
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "test-provider",
          target: "https://api.example.com/ping",
        },
      },
    });
    const result = res.json.result as { content: Array<{ type: string; text?: string }> };
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toBe('{"ok":true,"size":"small"}');
  });
});

describe("POST /mcp — resources/list + resources/read", () => {
  it("returns an empty resources/list initially", async () => {
    const app = createApp(makeDeps());
    const res = await rpc(app, { method: "resources/list" });
    const result = res.json.result as { resources: unknown[] };
    expect(result.resources).toEqual([]);
  });

  it("reads a resource that was previously spilled by provider_call", async () => {
    const pdfBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    const fetchFn = mock(
      async () =>
        new Response(pdfBytes, {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }));

    // 1. Call provider_call to spill bytes into the blob cache.
    const callRes = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "test-provider",
          target: "https://api.example.com/document.pdf",
        },
      },
    });
    const callResult = callRes.json.result as { content: Array<{ uri: string }> };
    const uri = callResult.content[0]!.uri;
    expect(uri).toMatch(/^appstrate:\/\/provider-response\/run-test\//);

    // 2. Read the resource and verify the bytes round-trip.
    const readRes = await rpc(app, {
      method: "resources/read",
      params: { uri },
    });
    const readResult = readRes.json.result as {
      contents: Array<{ uri: string; mimeType: string; blob?: string; text?: string }>;
    };
    expect(readResult.contents).toHaveLength(1);
    expect(readResult.contents[0]!.uri).toBe(uri);
    expect(readResult.contents[0]!.mimeType).toBe("application/pdf");
    expect(readResult.contents[0]!.blob).toBeDefined();
    // Decode base64 → bytes match.
    const decoded = Uint8Array.from(atob(readResult.contents[0]!.blob!), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(pdfBytes);
  });

  it("reads text resources as `text` rather than `blob`", async () => {
    // Spill a large JSON to force the resource path.
    const big = JSON.stringify({ x: "y".repeat(40 * 1024) });
    const fetchFn = mock(
      async () =>
        new Response(big, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }));
    const callRes = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "test-provider",
          target: "https://api.example.com/large.json",
        },
      },
    });
    const callResult = callRes.json.result as { content: Array<{ uri: string }> };
    const uri = callResult.content[0]!.uri;

    const readRes = await rpc(app, {
      method: "resources/read",
      params: { uri },
    });
    const readResult = readRes.json.result as {
      contents: Array<{ uri: string; text?: string; blob?: string }>;
    };
    expect(readResult.contents[0]!.text).toBe(big);
    expect(readResult.contents[0]!.blob).toBeUndefined();
  });

  it("rejects reads for unknown URIs with InvalidParams", async () => {
    const app = createApp(makeDeps());
    const res = await rpc(app, {
      method: "resources/read",
      params: { uri: "appstrate://provider-response/run-test/01HZX0Q3ABCDEFGHJKMNPQRSTV" },
    });
    expect(res.json.error).toBeDefined();
    expect(res.json.error!.code).toBe(-32602);
    expect(res.json.error!.message).toMatch(/Resource not found/);
  });

  it("rejects reads for cross-run URIs (security invariant)", async () => {
    const app = createApp(makeDeps()); // runId = run-test
    const res = await rpc(app, {
      method: "resources/read",
      params: { uri: "appstrate://provider-response/run-other/01HZX0Q3ABCDEFGHJKMNPQRSTV" },
    });
    expect(res.json.error).toBeDefined();
    expect(res.json.error!.code).toBe(-32602);
  });

  it("rejects reads for malformed URIs", async () => {
    const app = createApp(makeDeps());
    const res = await rpc(app, {
      method: "resources/read",
      params: { uri: "file:///etc/passwd" },
    });
    expect(res.json.error).toBeDefined();
    expect(res.json.error!.code).toBe(-32602);
  });
});
