// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the sidecar's first-party HTTP routes:
 *
 *   - `GET  /health`     — readiness probe.
 *   - `ALL  /llm/*`      — placeholder-substituting LLM reverse proxy
 *                          consumed by the in-container Pi SDK over HTTP.
 *
 * `/mcp` (mounted by `mountMcp`) is exercised in `mcp.test.ts`.
 * Credential-proxy invariants (cred fetch, allowlist matching, 401
 * retry) live in `credential-proxy.test.ts`.
 */

import { describe, it, expect, mock, spyOn } from "bun:test";
import { createApp, SIDECAR_IDLE_TIMEOUT_SECONDS, type AppDeps } from "../app.ts";
import type { CredentialsResponse, LlmProxyConfig } from "../helpers.ts";
import { logger } from "../logger.ts";

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

// --- SIDECAR_IDLE_TIMEOUT_SECONDS ---
//
// The actual `idleTimeout` value embedded in `server.ts`'s Bun.serve
// export. Pinned here (rather than in a `server.ts` import test) because
// `server.ts` has port-binding side effects at import time — bringing it
// into the test process would bind a real port. The constant lives in
// `app.ts` precisely so the bound can be asserted without that boot.
// See issue #426.

describe("SIDECAR_IDLE_TIMEOUT_SECONDS", () => {
  it("is set, sane, and under the run-tracker ceiling", () => {
    // Value must be > the previous (broken) 10 s Bun.serve default by a
    // wide margin. 60 s is the lowest credible LLM-stream pause we'd
    // tolerate (reasoning + parallel tool-call generation routinely
    // spans 15-45 s).
    expect(SIDECAR_IDLE_TIMEOUT_SECONDS).toBeGreaterThan(60);
    // Must stay strictly under the run-tracker's 300 s timeout so
    // genuinely dead connections get reclaimed before the run is
    // forcibly killed. Bun also caps `idleTimeout` at 255 s.
    expect(SIDECAR_IDLE_TIMEOUT_SECONDS).toBeLessThan(300);
    expect(SIDECAR_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(255);
  });
});

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
  it("returns 403 when oauth baseUrl targets a blocked network range", async () => {
    const deps = makeDeps();
    deps.config.llm = {
      authMode: "oauth",
      baseUrl: "http://169.254.169.254/metadata",
      credentialId: "cred_blocked",
    };
    const app = createApp(deps);
    const res = await app.request("/llm/v1/messages", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("blocked network range");
  });

  it("returns 403 when api_key baseUrl targets a blocked network range", async () => {
    const deps = makeDeps();
    deps.config.llm = {
      authMode: "api_key",
      baseUrl: "http://169.254.169.254/metadata",
      apiKey: "real-sk",
      placeholder: "sk-placeholder",
    };
    const app = createApp(deps);
    const res = await app.request("/llm/v1/messages", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("blocked network range");
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

// --- ALL /llm/* — telemetry ---
//
// `passUpstream` in app.ts wraps every successful LLM stream with a
// `ReadableStream` that emits one structured `llm.stream.observed` log
// on close. This is the long-term telemetry handle used to detect the
// next class of Bun.serve idleTimeout-style stream-cancellation bugs
// (see issue #426). Regressing the contract — silencing the log,
// dropping fields, or mis-naming `ttfbMs` — would make the next
// incident much harder to diagnose, so the emission shape is pinned
// here rather than left as an implicit side effect.

describe("ALL /llm/* — telemetry", () => {
  it("emits llm.stream.observed with TTFB, idle gap, and byte counters", async () => {
    const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
    try {
      const chunks = ["chunk-1-", "chunk-2-end"];
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
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
      // Drain the stream so `pull` runs to completion and the
      // observation closes — without this `llm.stream.observed` is
      // never emitted because the consumer never pulls.
      await res.text();

      const observed = infoSpy.mock.calls.find(([msg]) => msg === "llm.stream.observed");
      expect(observed).toBeDefined();
      const payload = observed?.[1] as Record<string, unknown> | undefined;
      expect(payload).toMatchObject({
        status: 200,
        authMode: "api_key",
        bytes: chunks.reduce((n, c) => n + new TextEncoder().encode(c).byteLength, 0),
        chunks: 2,
      });
      // `ttfbMs` is set on the first chunk (time-to-first-byte, not
      // time-to-last-byte — the original draft of #426 mis-named this).
      expect(typeof payload?.ttfbMs).toBe("number");
      expect(payload?.ttfbMs).toBeGreaterThanOrEqual(0);
      // `maxIdleMs` is always present even if 0 (chunks back-to-back).
      expect(typeof payload?.maxIdleMs).toBe("number");
      expect(payload?.maxIdleMs).toBeGreaterThanOrEqual(0);
      // `totalMs` is monotonically >= ttfbMs.
      expect(payload?.totalMs).toBeGreaterThanOrEqual(payload?.ttfbMs as number);
      expect(payload?.targetUrl).toBe("https://api.anthropic.com/v1/messages");
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("emits llm.stream.cancelled when the consumer aborts mid-stream", async () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      // Upstream that never closes — forces the consumer-side cancel
      // path to fire (the failure mode that was burning the run
      // timeout before #426).
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first-chunk"));
          // Intentionally never close.
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
      const reader = res.body!.getReader();
      await reader.read(); // pull the first chunk
      await reader.cancel("test-abort");

      const cancelled = warnSpy.mock.calls.find(([msg]) => msg === "llm.stream.cancelled");
      expect(cancelled).toBeDefined();
      const payload = cancelled?.[1] as Record<string, unknown> | undefined;
      expect(payload).toMatchObject({ status: 200, authMode: "api_key" });
      expect(String(payload?.reason)).toContain("test-abort");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
