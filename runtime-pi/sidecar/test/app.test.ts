// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, mock } from "bun:test";
import { createApp, type AppDeps } from "../app.ts";
import type { CredentialsResponse, LlmProxyConfig } from "../helpers.ts";

function makeDeps(overrides?: Partial<AppDeps>): AppDeps {
  return {
    config: { platformApiUrl: "http://mock:3000", executionToken: "tok", proxyUrl: "" },
    fetchCredentials: mock(
      async (): Promise<CredentialsResponse> => ({
        credentials: { access_token: "test-123" },
        authorizedUris: ["https://api.example.com/*"],
        allowAllUris: false,
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
  it("updates executionToken", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const res = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ executionToken: "new-tok" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(deps.config.executionToken).toBe("new-tok");
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
      body: JSON.stringify({ executionToken: "x" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(deps.cookieJar.size).toBe(0);
  });

  it("partial update keeps other fields", async () => {
    const deps = makeDeps();
    deps.config.platformApiUrl = "http://original:3000";
    deps.config.executionToken = "orig-tok";
    const app = createApp(deps);
    await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ executionToken: "new-tok" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(deps.config.executionToken).toBe("new-tok");
    expect(deps.config.platformApiUrl).toBe("http://original:3000");
  });

  it("rejects without valid configSecret when set", async () => {
    const app = createApp(makeDeps({ configSecret: "secret-123" }));
    const res = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ executionToken: "new-tok" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
  });

  it("accepts valid configSecret", async () => {
    const deps = makeDeps({ configSecret: "secret-123" });
    const app = createApp(deps);
    const res = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ executionToken: "new-tok" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-123",
      },
    });
    expect(res.status).toBe(200);
    expect(deps.config.executionToken).toBe("new-tok");
  });

  it("rejects second configure call (one-time)", async () => {
    const app = createApp(makeDeps({ configSecret: "secret-123" }));
    // First call succeeds
    const res1 = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ executionToken: "tok1" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-123",
      },
    });
    expect(res1.status).toBe(200);
    // Second call rejected
    const res2 = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ executionToken: "tok2" }),
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
      body: JSON.stringify({ executionToken: "new-tok" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Already configured");
  });
});

// --- GET /run-history (+ /execution-history backwards compat) ---

describe("GET /run-history", () => {
  it("proxies to platform API", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"entries":[]}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/run-history");
    expect(res.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const url = (fetchFn.mock.calls[0] as [string])[0];
    expect(url).toBe("http://mock:3000/internal/run-history");
  });

  it("forwards query string", async () => {
    const fetchFn = mock(
      async () =>
        new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn }));
    await app.request("/run-history?limit=10&offset=0");
    const url = (fetchFn.mock.calls[0] as [string])[0];
    expect(url).toContain("?limit=10&offset=0");
  });

  it("sends auth header", async () => {
    const fetchFn = mock(
      async () =>
        new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn }));
    await app.request("/run-history");
    const opts = (fetchFn.mock.calls[0] as [string, RequestInit])[1];
    expect((opts.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("returns 502 on fetch failure", async () => {
    const fetchFn = mock(async () => {
      throw new Error("connection refused");
    });
    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/run-history");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeDefined();
  });

  it("supports legacy /execution-history path", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"entries":[]}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/execution-history");
    expect(res.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const url = (fetchFn.mock.calls[0] as [string])[0];
    expect(url).toBe("http://mock:3000/internal/run-history");
  });
});

// --- ALL /proxy — validation ---

describe("ALL /proxy — validation", () => {
  it("returns 400 without X-Provider", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/proxy", {
      method: "GET",
      headers: { "X-Target": "https://api.example.com/v1" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("X-Provider");
  });

  it("returns 400 without X-Target", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/proxy", {
      method: "GET",
      headers: { "X-Provider": "gmail" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("X-Target");
  });

  it("returns 400 for invalid provider ID", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/proxy", {
      method: "GET",
      headers: { "X-Provider": "../etc/passwd", "X-Target": "https://api.example.com/v1" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Invalid X-Provider");
  });

  it("returns 502 when credential fetch fails", async () => {
    const fetchCredentials = mock(async () => {
      throw new Error("not found");
    });
    const app = createApp(makeDeps({ fetchCredentials }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: { "X-Provider": "gmail", "X-Target": "https://api.example.com/v1" },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not found");
  });

  it("returns 502 with platform detail when provider is unknown", async () => {
    const fetchCredentials = mock(async () => {
      throw new Error("Provider '@appstrate/gmail' is not required by this agent");
    });
    const app = createApp(makeDeps({ fetchCredentials }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: { "X-Provider": "@appstrate/gmail", "X-Target": "https://api.example.com/v1" },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("is not required by this agent");
  });

  it("returns 400 for unresolved placeholders in URL", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://{{unknown_host}}/api",
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Unresolved placeholders in URL");
  });

  it("returns 403 when URL not in authorizedUris", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://evil.com/steal",
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not authorized");
  });

  it("returns 403 when allowAllUris but URL targets blocked host", async () => {
    const fetchCredentials = mock(
      async (): Promise<CredentialsResponse> => ({
        credentials: { access_token: "t" },
        authorizedUris: null,
        allowAllUris: true,
      }),
    );
    const app = createApp(makeDeps({ fetchCredentials }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "http://127.0.0.1/admin",
      },
    });
    expect(res.status).toBe(403);
  });

  it("returns 403 when no authorizedUris and URL targets blocked host", async () => {
    const fetchCredentials = mock(
      async (): Promise<CredentialsResponse> => ({
        credentials: { access_token: "t" },
        authorizedUris: null,
        allowAllUris: false,
      }),
    );
    const app = createApp(makeDeps({ fetchCredentials }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "http://169.254.169.254/metadata",
      },
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 for unresolved placeholders in headers", async () => {
    const fetchCredentials = mock(
      async (): Promise<CredentialsResponse> => ({
        credentials: {},
        authorizedUris: ["https://api.example.com/*"],
        allowAllUris: false,
      }),
    );
    const app = createApp(makeDeps({ fetchCredentials }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1",
        Authorization: "Bearer {{missing_token}}",
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Unresolved placeholders in header");
  });
});

// --- ALL /proxy — forwarding ---

describe("ALL /proxy — forwarding", () => {
  it("forwards GET request to target", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"data":1}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/data",
      },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"data":1}');
    const url = (fetchFn.mock.calls[0] as [string])[0];
    expect(url).toBe("https://api.example.com/v1/data");
  });

  it("forwards POST request with body", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"created":true}', {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "POST",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/items",
        "Content-Type": "application/json",
      },
      body: '{"name":"test"}',
    });
    expect(res.status).toBe(201);
  });

  it("substitutes variables in URL", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const app = createApp(makeDeps({ fetchFn }));
    await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/{{access_token}}/data",
      },
    });
    const url = (fetchFn.mock.calls[0] as [string])[0];
    expect(url).toBe("https://api.example.com/v1/test-123/data");
  });

  it("substitutes variables in body when X-Substitute-Body set", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const app = createApp(makeDeps({ fetchFn }));
    await app.request("/proxy", {
      method: "POST",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/action",
        "X-Substitute-Body": "true",
        "Content-Type": "application/json",
      },
      body: '{"token":"{{access_token}}"}',
    });
    const opts = (fetchFn.mock.calls[0] as [string, RequestInit])[1];
    expect(opts.body).toBe('{"token":"test-123"}');
  });

  it("returns 400 for unresolved placeholders in body", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/proxy", {
      method: "POST",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/action",
        "X-Substitute-Body": "true",
        "Content-Type": "application/json",
      },
      body: '{"secret":"{{unknown_var}}"}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Unresolved placeholders in body");
  });

  it("returns 413 for oversized body with X-Substitute-Body", async () => {
    const app = createApp(makeDeps());
    const largeBody = "x".repeat(6 * 1024 * 1024); // 6MB > 5MB limit
    const res = await app.request("/proxy", {
      method: "POST",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/action",
        "X-Substitute-Body": "true",
        "Content-Type": "text/plain",
      },
      body: largeBody,
    });
    expect(res.status).toBe(413);
  });

  it("returns 502 when target request fails", async () => {
    const err = new Error("connection failed");
    (err as unknown as { code: string }).code = "ECONNREFUSED";
    const fetchFn = mock(async () => {
      throw err;
    });
    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1",
      },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Upstream request failed");
    expect(body.error).toBeDefined();
    expect(body.error).toContain("api.example.com");
  });

  it("truncates response over MAX_RESPONSE_SIZE", async () => {
    const largeBody = "x".repeat(60_000);
    const fetchFn = mock(
      async () =>
        new Response(largeBody, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/large",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Truncated")).toBe("true");
    const text = await res.text();
    expect(text.length).toBe(50_000);
  });

  it("X-Max-Response-Size increases the truncation limit", async () => {
    const largeBody = "x".repeat(100_000);
    const fetchFn = mock(
      async () =>
        new Response(largeBody, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/large",
        "X-Max-Response-Size": "200000",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Truncated")).toBeNull();
    const text = await res.text();
    expect(text.length).toBe(100_000);
  });

  it("X-Max-Response-Size is capped at ABSOLUTE_MAX_RESPONSE_SIZE", async () => {
    const largeBody = "x".repeat(2_000_000);
    const fetchFn = mock(
      async () =>
        new Response(largeBody, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/huge",
        "X-Max-Response-Size": "5000000",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Truncated")).toBe("true");
    const text = await res.text();
    expect(text.length).toBe(1_000_000);
  });

  it("invalid X-Max-Response-Size falls back to default", async () => {
    const largeBody = "x".repeat(60_000);
    const fetchFn = mock(
      async () =>
        new Response(largeBody, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/large",
        "X-Max-Response-Size": "abc",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Truncated")).toBe("true");
    const text = await res.text();
    expect(text.length).toBe(50_000);
  });

  it("stores Set-Cookie headers in cookie jar", async () => {
    const deps = makeDeps();
    const fetchFn = mock(async () => {
      const headers = new Headers();
      headers.append("Set-Cookie", "sid=abc123; Path=/; HttpOnly");
      headers.append("Content-Type", "application/json");
      return new Response('{"ok":true}', { status: 200, headers });
    });
    deps.fetchFn = fetchFn;
    const app = createApp(deps);
    await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/login",
      },
    });
    const cookies = deps.cookieJar.get("gmail");
    expect(cookies).toBeDefined();
    expect(cookies!.some((c) => c.startsWith("sid="))).toBe(true);
  });

  it("injects stored cookies from cookie jar", async () => {
    const deps = makeDeps();
    deps.cookieJar.set("gmail", ["sid=abc123"]);
    const fetchFn = mock(
      async () =>
        new Response("ok", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    deps.fetchFn = fetchFn;
    const app = createApp(deps);
    await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/data",
      },
    });
    const opts = (fetchFn.mock.calls[0] as [string, RequestInit])[1];
    const headers = opts.headers as Record<string, string>;
    expect(headers["cookie"]).toContain("sid=abc123");
  });

  it("strips routing headers from forwarded request", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const app = createApp(makeDeps({ fetchFn }));
    await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1",
        "X-Custom": "keep-me",
      },
    });
    const opts = (fetchFn.mock.calls[0] as [string, RequestInit])[1];
    const headers = opts.headers as Record<string, string>;
    expect(headers["x-provider"]).toBeUndefined();
    expect(headers["x-target"]).toBeUndefined();
    expect(headers["x-custom"]).toBe("keep-me");
  });

  it("substitutes variables in headers", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const app = createApp(makeDeps({ fetchFn }));
    await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1",
        Authorization: "Bearer {{access_token}}",
      },
    });
    const opts = (fetchFn.mock.calls[0] as [string, RequestInit])[1];
    const headers = opts.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer test-123");
  });
});

// --- ALL /llm/* — LLM reverse proxy ---

const LLM_CONFIG: LlmProxyConfig = {
  baseUrl: "https://api.anthropic.com",
  apiKey: "real-sk-ant-key",
  placeholder: "sk-placeholder",
};

describe("ALL /llm/* — SSRF protection", () => {
  it("returns 403 when baseUrl targets localhost", async () => {
    const deps = makeDeps();
    deps.config.llm = { baseUrl: "http://localhost:8000", apiKey: "key", placeholder: "ph" };
    const app = createApp(deps);
    const res = await app.request("/llm/v1/messages", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("blocked network range");
  });

  it("returns 403 when baseUrl targets cloud metadata", async () => {
    const deps = makeDeps();
    deps.config.llm = {
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
    deps.config.llm = { baseUrl: "http://10.0.0.1:8080", apiKey: "key", placeholder: "ph" };
    const app = createApp(deps);
    const res = await app.request("/llm/v1/messages", { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("allows public baseUrl", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const deps = makeDeps({ fetchFn });
    deps.config.llm = { baseUrl: "https://api.anthropic.com", apiKey: "key", placeholder: "ph" };
    const app = createApp(deps);
    const res = await app.request("/llm/v1/messages", { method: "POST" });
    expect(res.status).toBe(200);
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

  it("extracts path after /llm and forwards to target", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"id":"msg_1"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const deps = makeDeps({ fetchFn });
    deps.config.llm = LLM_CONFIG;
    const app = createApp(deps);
    const res = await app.request("/llm/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"model":"claude-sonnet-4-5-20250929"}',
    });
    expect(res.status).toBe(200);
    const url = (fetchFn.mock.calls[0] as [string])[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("forwards query string", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const deps = makeDeps({ fetchFn });
    deps.config.llm = LLM_CONFIG;
    const app = createApp(deps);
    await app.request("/llm/v1/messages?stream=true", { method: "POST" });
    const url = (fetchFn.mock.calls[0] as [string])[0];
    expect(url).toContain("?stream=true");
  });

  it("returns 502 when target request fails", async () => {
    const fetchFn = mock(async () => {
      throw new Error("ECONNREFUSED");
    });
    const deps = makeDeps({ fetchFn });
    deps.config.llm = LLM_CONFIG;
    const app = createApp(deps);
    const res = await app.request("/llm/v1/messages", { method: "POST" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeDefined();
  });

  it("forwards upstream error status transparently", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"error":"rate_limited"}', {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const deps = makeDeps({ fetchFn });
    deps.config.llm = LLM_CONFIG;
    const app = createApp(deps);
    const res = await app.request("/llm/v1/messages", { method: "POST" });
    expect(res.status).toBe(429);
  });
});

describe("ALL /llm/* — placeholder replacement", () => {
  it("replaces placeholder in x-api-key header", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const deps = makeDeps({ fetchFn });
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

  it("replaces placeholder in Authorization Bearer header", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const deps = makeDeps({ fetchFn });
    deps.config.llm = {
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

  it("preserves non-placeholder headers unchanged", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const deps = makeDeps({ fetchFn });
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
    const deps = makeDeps({ fetchFn });
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
    deps.config.llm = { baseUrl: "https://api.openai.com", apiKey: "key", placeholder: "ph" };
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
        executionToken: "tok",
        llm: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-oai",
          placeholder: "sk-placeholder",
        },
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(deps.config.llm).toEqual({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-oai",
      placeholder: "sk-placeholder",
    });
  });
});
