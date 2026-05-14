// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the sidecar's first-party HTTP routes:
 *
 *   - `GET  /health`     — readiness probe.
 *   - `POST /configure`  — one-time runtime config injection.
 *   - `ALL  /llm/*`      — placeholder-substituting LLM reverse proxy
 *                          consumed by the in-container Pi SDK over HTTP.
 *
 * `/mcp` (mounted by `mountMcp`) is exercised in `mcp.test.ts`.
 * Credential-proxy invariants (cred fetch, allowlist matching, 401
 * retry) live in `credential-proxy.test.ts`.
 */

import { describe, it, expect, mock } from "bun:test";
import { createApp, type AppDeps } from "../app.ts";
import type { CredentialsResponse, LlmProxyConfig } from "../helpers.ts";

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
    ) as unknown as typeof fetch,
    isReady: () => true,
    ...overrides,
  };
}

// --- GET /health ---

describe("GET /health", () => {
  it("returns 200 when ready", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 503 when not ready", async () => {
    const app = createApp(makeDeps({ isReady: () => false }));
    const res = await app.request("/health");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; proxy: string };
    expect(body.status).toBe("degraded");
  });

  it("response has correct content-type", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/health");
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

// --- POST /configure ---

describe("POST /configure", () => {
  it("updates run token", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const res = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ runToken: "new-tok" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(deps.config.runToken).toBe("new-tok");
  });

  it("updates platformApiUrl", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ platformApiUrl: "http://new:4000" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(deps.config.platformApiUrl).toBe("http://new:4000");
  });

  it("updates proxyUrl to empty string", async () => {
    const deps = makeDeps();
    deps.config.proxyUrl = "http://proxy:8080";
    const app = createApp(deps);
    await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ proxyUrl: "" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(deps.config.proxyUrl).toBe("");
  });

  it("clears cookie jar", async () => {
    const deps = makeDeps();
    deps.cookieJar.set("gmail", ["sid=abc"]);
    const app = createApp(deps);
    await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ runToken: "x" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(deps.cookieJar.size).toBe(0);
  });

  it("partial update keeps other fields", async () => {
    const deps = makeDeps();
    deps.config.platformApiUrl = "http://original:3000";
    deps.config.runToken = "orig-tok";
    const app = createApp(deps);
    await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ runToken: "new-tok" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(deps.config.runToken).toBe("new-tok");
    expect(deps.config.platformApiUrl).toBe("http://original:3000");
  });

  it("rejects without valid configSecret when set", async () => {
    const app = createApp(makeDeps({ configSecret: "secret-123" }));
    const res = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ runToken: "new-tok" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
  });

  it("accepts valid configSecret", async () => {
    const deps = makeDeps({ configSecret: "secret-123" });
    const app = createApp(deps);
    const res = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ runToken: "new-tok" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-123",
      },
    });
    expect(res.status).toBe(200);
    expect(deps.config.runToken).toBe("new-tok");
  });

  it("rejects second configure call (one-time)", async () => {
    const app = createApp(makeDeps({ configSecret: "secret-123" }));
    const res1 = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ runToken: "tok1" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-123",
      },
    });
    expect(res1.status).toBe(200);
    const res2 = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ runToken: "tok2" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-123",
      },
    });
    expect(res2.status).toBe(403);
  });

  it("rejects when preConfigured is set (fresh sidecar)", async () => {
    const app = createApp(makeDeps({ preConfigured: true }));
    const res = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ runToken: "new-tok" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Already configured");
  });
});

describe("POST /configure — llm SSRF protection", () => {
  it("rejects llm config with blocked baseUrl", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const res = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({
        llm: { baseUrl: "http://169.254.169.254/metadata", apiKey: "key", placeholder: "ph" },
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("blocked network range");
    expect(deps.config.llm).toBeUndefined();
  });

  it("allows llm config with null (clear)", async () => {
    const deps = makeDeps();
    deps.config.llm = {
      authMode: "api_key",
      baseUrl: "https://api.openai.com",
      apiKey: "key",
      placeholder: "ph",
    };
    const app = createApp(deps);
    const res = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ llm: null }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(deps.config.llm).toBeNull();
  });
});

describe("POST /configure — llm field", () => {
  it("updates llm config", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const res = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({
        runToken: "tok",
        llm: {
          authMode: "api_key",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-oai",
          placeholder: "sk-placeholder",
        },
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(deps.config.llm).toEqual({
      authMode: "api_key",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-oai",
      placeholder: "sk-placeholder",
    });
  });
});

// --- ALL /llm/* — LLM reverse proxy ---
//
// The Pi SDK in the agent container makes HTTP calls to
// `${MODEL_BASE_URL}/v1/chat/completions` (or equivalent). The platform
// wires `MODEL_BASE_URL = http://sidecar:8080/llm` (Docker mode) or
// `http://localhost:<port>/llm` (process orchestrator). The sidecar
// owns the real LLM API key and substitutes a per-run placeholder
// embedded in the SDK-generated headers, then streams the upstream
// response back to the agent.

const LLM_CONFIG: LlmProxyConfig = {
  authMode: "api_key",
  baseUrl: "https://api.anthropic.com",
  apiKey: "real-sk-ant-key",
  placeholder: "sk-placeholder",
};

describe("ALL /llm/* — SSRF protection", () => {
  it("returns 403 when baseUrl targets localhost", async () => {
    const deps = makeDeps();
    deps.config.llm = {
      authMode: "api_key",
      baseUrl: "http://localhost:8000",
      apiKey: "key",
      placeholder: "ph",
    };
    const app = createApp(deps);
    const res = await app.request("/llm/v1/messages", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("blocked network range");
  });

  it("returns 403 when baseUrl targets cloud metadata", async () => {
    const deps = makeDeps();
    deps.config.llm = {
      authMode: "api_key",
      baseUrl: "http://169.254.169.254/metadata",
      apiKey: "key",
      placeholder: "ph",
    };
    const app = createApp(deps);
    const res = await app.request("/llm/v1/messages", { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("returns 403 when baseUrl targets private IP", async () => {
    const deps = makeDeps();
    deps.config.llm = {
      authMode: "api_key",
      baseUrl: "http://10.0.0.1:8080",
      apiKey: "key",
      placeholder: "ph",
    };
    const app = createApp(deps);
    const res = await app.request("/llm/v1/messages", { method: "POST" });
    expect(res.status).toBe(403);
  });
});

describe("ALL /llm/* — basic routing", () => {
  it("returns 503 when llm config not set", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/llm/v1/messages", { method: "POST" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not configured");
  });

  it("forwards path and query string to baseUrl", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"id":"msg_1"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const deps = makeDeps({ fetchFn: fetchFn as unknown as typeof fetch });
    deps.config.llm = LLM_CONFIG;
    const app = createApp(deps);
    const res = await app.request("/llm/v1/messages?stream=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"model":"claude-sonnet-4-5"}',
    });
    expect(res.status).toBe(200);
    const url = (fetchFn.mock.calls[0] as [string])[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages?stream=true");
  });

  it("returns 502 with hostname hint when upstream fetch fails", async () => {
    const fetchFn = mock(async () => {
      throw new Error("ECONNREFUSED");
    });
    const deps = makeDeps({ fetchFn: fetchFn as unknown as typeof fetch });
    deps.config.llm = LLM_CONFIG;
    const app = createApp(deps);
    const res = await app.request("/llm/v1/messages", { method: "POST" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("api.anthropic.com");
  });

  it("forwards upstream error status transparently", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"error":"rate_limited"}', {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const deps = makeDeps({ fetchFn: fetchFn as unknown as typeof fetch });
    deps.config.llm = LLM_CONFIG;
    const app = createApp(deps);
    const res = await app.request("/llm/v1/messages", { method: "POST" });
    expect(res.status).toBe(429);
  });
});

describe("ALL /llm/* — placeholder replacement", () => {
  it("replaces placeholder in x-api-key header", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const deps = makeDeps({ fetchFn: fetchFn as unknown as typeof fetch });
    deps.config.llm = LLM_CONFIG;
    const app = createApp(deps);
    await app.request("/llm/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "sk-placeholder" },
    });
    const opts = (fetchFn.mock.calls[0] as [string, RequestInit])[1];
    const headers = opts.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("real-sk-ant-key");
  });

  it("replaces placeholder embedded in Authorization Bearer header", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const deps = makeDeps({ fetchFn: fetchFn as unknown as typeof fetch });
    deps.config.llm = {
      authMode: "api_key",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-oat01-real-token",
      placeholder: "sk-ant-oat01-placeholder",
    };
    const app = createApp(deps);
    await app.request("/llm/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer sk-ant-oat01-placeholder" },
    });
    const opts = (fetchFn.mock.calls[0] as [string, RequestInit])[1];
    const headers = opts.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-ant-oat01-real-token");
  });

  it("preserves headers that do not contain the placeholder", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const deps = makeDeps({ fetchFn: fetchFn as unknown as typeof fetch });
    deps.config.llm = LLM_CONFIG;
    const app = createApp(deps);
    await app.request("/llm/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": "sk-placeholder",
        "Content-Type": "application/json",
        "X-Custom": "untouched",
      },
    });
    const opts = (fetchFn.mock.calls[0] as [string, RequestInit])[1];
    const headers = opts.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("real-sk-ant-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-custom"]).toBe("untouched");
  });
});

describe("ALL /llm/* — Portkey config forwarding", () => {
  it("attaches x-portkey-config when present on the LLM config", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const deps = makeDeps({ fetchFn: fetchFn as unknown as typeof fetch });
    const portkeyConfig = JSON.stringify({ provider: "openai", api_key: "real-sk-ant-key" });
    deps.config.llm = {
      authMode: "api_key",
      baseUrl: "https://api.example.com",
      apiKey: "real-sk-ant-key",
      placeholder: "sk-placeholder",
      portkeyConfig,
    };
    const app = createApp(deps);
    await app.request("/llm/v1/messages", { method: "POST" });
    const opts = (fetchFn.mock.calls[0] as [string, RequestInit])[1];
    const headers = opts.headers as Record<string, string>;
    expect(headers["x-portkey-config"]).toBe(portkeyConfig);
  });

  it("does not attach x-portkey-config when absent (legacy direct-upstream path)", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const deps = makeDeps({ fetchFn: fetchFn as unknown as typeof fetch });
    deps.config.llm = LLM_CONFIG;
    const app = createApp(deps);
    await app.request("/llm/v1/messages", { method: "POST" });
    const opts = (fetchFn.mock.calls[0] as [string, RequestInit])[1];
    const headers = opts.headers as Record<string, string>;
    expect(headers["x-portkey-config"]).toBeUndefined();
  });
});

describe("ALL /llm/* — streaming", () => {
  it("streams response body through without buffering", async () => {
    const chunks = ['data: {"type":"content"}\n\n', "data: [DONE]\n\n"];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });
    const fetchFn = mock(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    const deps = makeDeps({ fetchFn: fetchFn as unknown as typeof fetch });
    deps.config.llm = LLM_CONFIG;
    const app = createApp(deps);
    const res = await app.request("/llm/v1/messages", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain('data: {"type":"content"}');
    expect(text).toContain("data: [DONE]");
  });
});
