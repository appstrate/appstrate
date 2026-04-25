// SPDX-License-Identifier: Apache-2.0

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
    // First call succeeds
    const res1 = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ runToken: "tok1" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-123",
      },
    });
    expect(res1.status).toBe(200);
    // Second call rejected
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

// --- GET /run-history ---

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
        credentialFieldName: "access_token",
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
        credentialFieldName: "access_token",
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
        authorizedUris: ["https://api.example.com/**"],
        allowAllUris: false,
        credentialFieldName: "access_token",
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
    const largeBody = "x".repeat(300_000); // > 256 KB default
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
    expect(text.length).toBe(256 * 1024);
  });

  it("X-Max-Response-Size increases the truncation limit", async () => {
    const largeBody = "x".repeat(300_000); // > 256 KB default, < 400_000 cap
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
        "X-Max-Response-Size": "400000",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Truncated")).toBeNull();
    const text = await res.text();
    expect(text.length).toBe(300_000);
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

  it("X-Max-Response-Size = ABSOLUTE_MAX_RESPONSE_SIZE returns 600 KB payload untruncated", async () => {
    // Round-trip a 600 KB payload with the explicit cap exactly at the
    // sidecar's absolute ceiling: under cap → full body, no X-Truncated.
    const largeBody = "x".repeat(600_000);
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
        "X-Max-Response-Size": "1000000",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Truncated")).toBeNull();
    const text = await res.text();
    expect(text.length).toBe(600_000);
  });

  it("invalid X-Max-Response-Size falls back to default", async () => {
    const largeBody = "x".repeat(300_000); // > 256 KB default
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
    expect(text.length).toBe(256 * 1024);
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

// --- ALL /proxy — server-side credential injection ---

/**
 * The sidecar writes the upstream auth header itself based on the
 * `credentialHeaderName` / `credentialHeaderPrefix` / `credentialFieldName`
 * fields returned by the platform's `/internal/credentials` endpoint.
 * The agent never touches the credential — no placeholders on the wire,
 * no way for the LLM to exfiltrate the token through header-value
 * manipulation.
 */
describe("ALL /proxy — server-side credential injection", () => {
  it("injects Authorization: Bearer <token> when manifest declares OAuth2 transport", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "@appstrate/gmail",
        "X-Target": "https://api.example.com/messages",
      },
    });
    expect(res.status).toBe(200);
    expect(capturedHeaders?.Authorization).toBe("Bearer test-123");
  });

  it("injects X-Api-Key: <token> without prefix when manifest declares api_key transport", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response("{}", { status: 200 });
    });
    const fetchCredentials = mock(
      async (): Promise<CredentialsResponse> => ({
        credentials: { api_key: "sk_live_xyz" },
        authorizedUris: ["https://api.example.com/**"],
        allowAllUris: false,
        credentialHeaderName: "X-Api-Key",
        credentialHeaderPrefix: undefined,
        credentialFieldName: "api_key",
      }),
    );
    const app = createApp(makeDeps({ fetchFn, fetchCredentials }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "@appstrate/stripe",
        "X-Target": "https://api.example.com/charges",
      },
    });
    expect(res.status).toBe(200);
    expect(capturedHeaders?.["x-api-key"] ?? capturedHeaders?.["X-Api-Key"]).toBe("sk_live_xyz");
    // No Authorization header was written — prefix-less API-key auth
    // must not leak into a Bearer slot.
    expect(capturedHeaders?.Authorization).toBeUndefined();
  });

  it("respects a caller-supplied header (case-insensitive) instead of injecting", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response("{}", { status: 200 });
    });
    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "@appstrate/gmail",
        "X-Target": "https://api.example.com/me",
        // Agent passes a dual-auth / override token. The sidecar must
        // not clobber it server-side — the override case preserves
        // flexibility for exotic flows.
        authorization: "Bearer caller-override",
      },
    });
    expect(res.status).toBe(200);
    expect(capturedHeaders?.authorization ?? capturedHeaders?.Authorization).toBe(
      "Bearer caller-override",
    );
    expect(capturedHeaders?.Authorization ?? capturedHeaders?.authorization).not.toContain(
      "test-123",
    );
  });

  it("does not inject when manifest omits credentialHeaderName (basic/custom auth)", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response("{}", { status: 200 });
    });
    const fetchCredentials = mock(
      async (): Promise<CredentialsResponse> => ({
        credentials: { access_token: "unused-by-transport" },
        authorizedUris: ["https://api.example.com/**"],
        allowAllUris: false,
        // No credentialHeaderName → agent is expected to write its own
        // auth (e.g. a basic-auth header already rendered in a skill).
        credentialFieldName: "access_token",
      }),
    );
    const app = createApp(makeDeps({ fetchFn, fetchCredentials }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "@appstrate/custom",
        "X-Target": "https://api.example.com/thing",
      },
    });
    expect(res.status).toBe(200);
    expect(capturedHeaders?.Authorization).toBeUndefined();
    expect(capturedHeaders?.authorization).toBeUndefined();
  });

  it("re-injects the refreshed token on 401 retry", async () => {
    const captured: string[] = [];
    let callCount = 0;
    const deps = makeDeps({
      fetchCredentials: mock(
        async (): Promise<CredentialsResponse> => ({
          credentials: { access_token: "old-token" },
          authorizedUris: ["https://api.example.com/**"],
          allowAllUris: false,
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer",
          credentialFieldName: "access_token",
        }),
      ),
      refreshCredentials: mock(
        async (): Promise<CredentialsResponse> => ({
          credentials: { access_token: "new-token" },
          authorizedUris: ["https://api.example.com/**"],
          allowAllUris: false,
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer",
          credentialFieldName: "access_token",
        }),
      ),
      fetchFn: mock(async (_url: string, init?: RequestInit) => {
        callCount++;
        const headers = init?.headers as Record<string, string>;
        const auth = headers?.authorization ?? headers?.Authorization ?? "";
        captured.push(auth);
        if (auth.includes("old-token")) {
          return new Response("Unauthorized", { status: 401 });
        }
        return new Response("{}", { status: 200 });
      }),
    });
    const app = createApp(deps);
    // Agent sends no auth header — injection is the only source.
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "@appstrate/gmail",
        "X-Target": "https://api.example.com/me",
      },
    });
    expect(res.status).toBe(200);
    expect(callCount).toBe(2);
    expect(captured[0]).toBe("Bearer old-token");
    expect(captured[1]).toBe("Bearer new-token");
  });
});

// --- ALL /proxy — binary body integrity ---

describe("ALL /proxy — binary body integrity", () => {
  it("preserves binary body with non-UTF-8 bytes", async () => {
    // Bytes that are invalid UTF-8 — would be replaced by U+FFFD if decoded as text
    const binaryPayload = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0xc0, 0x41, 0x42]);
    let capturedBody: ArrayBuffer | undefined;

    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      if (init?.body instanceof ArrayBuffer) {
        capturedBody = init.body;
      }
      return new Response("ok", { status: 200 });
    });

    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "POST",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/upload",
        "Content-Type": "application/octet-stream",
      },
      body: binaryPayload.buffer,
    });

    expect(res.status).toBe(200);
    expect(capturedBody).toBeDefined();
    const forwarded = new Uint8Array(capturedBody!);
    expect(forwarded).toEqual(binaryPayload);
  });

  it("preserves binary body on retry after 401", async () => {
    const binaryPayload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG header
    let capturedBody: ArrayBuffer | undefined;

    const deps = makeDeps({
      refreshCredentials: mock(
        async (): Promise<CredentialsResponse> => ({
          credentials: { access_token: "new-token" },
          authorizedUris: ["https://api.example.com/**"],
          allowAllUris: false,
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer",
          credentialFieldName: "access_token",
        }),
      ),
      fetchFn: mock(async (_url: string, init?: RequestInit) => {
        const authHeader = (init?.headers as Record<string, string>)?.["authorization"] ?? "";
        if (authHeader.includes("old-token")) {
          return new Response("Unauthorized", { status: 401 });
        }
        if (init?.body instanceof ArrayBuffer) {
          capturedBody = init.body;
        }
        return new Response("ok", { status: 200 });
      }),
      fetchCredentials: mock(
        async (): Promise<CredentialsResponse> => ({
          credentials: { access_token: "old-token" },
          authorizedUris: ["https://api.example.com/**"],
          allowAllUris: false,
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer",
          credentialFieldName: "access_token",
        }),
      ),
    });

    const app = createApp(deps);
    const res = await app.request("/proxy", {
      method: "POST",
      headers: {
        "X-Provider": "@test/github",
        "X-Target": "https://api.example.com/upload",
        Authorization: "Bearer {{access_token}}",
        "Content-Type": "application/octet-stream",
      },
      body: binaryPayload.buffer,
    });

    expect(res.status).toBe(200);
    expect(capturedBody).toBeDefined();
    const forwarded = new Uint8Array(capturedBody!);
    expect(forwarded).toEqual(binaryPayload);
  });

  it("forwards empty POST body without error", async () => {
    let capturedBody: BodyInit | undefined;

    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body ?? undefined;
      return new Response("ok", { status: 200 });
    });

    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "POST",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/action",
        "Content-Type": "application/json",
      },
    });

    expect(res.status).toBe(200);
    // Empty body: arrayBuffer() returns 0-length buffer
    if (capturedBody instanceof ArrayBuffer) {
      expect(capturedBody.byteLength).toBe(0);
    }
  });

  it("decodes binary as text only when X-Substitute-Body is set", async () => {
    // Valid JSON as bytes — should be decoded for substitution
    const jsonBytes = new TextEncoder().encode('{"token":"{{access_token}}"}');
    let capturedBody: string | undefined;

    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      if (typeof init?.body === "string") {
        capturedBody = init.body;
      }
      return new Response("ok", { status: 200 });
    });

    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "POST",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/action",
        "X-Substitute-Body": "true",
        "Content-Type": "application/json",
      },
      body: jsonBytes.buffer,
    });

    expect(res.status).toBe(200);
    expect(capturedBody).toBe('{"token":"test-123"}');
  });

  it("passes binary body as ArrayBuffer when X-Substitute-Body is not set", async () => {
    const binaryPayload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    let bodyIsArrayBuffer = false;

    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      bodyIsArrayBuffer = init?.body instanceof ArrayBuffer;
      return new Response("ok", { status: 200 });
    });

    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "POST",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/upload",
        "Content-Type": "application/octet-stream",
      },
      body: binaryPayload.buffer,
    });

    expect(res.status).toBe(200);
    expect(bodyIsArrayBuffer).toBe(true);
  });

  it("preserves binary response bytes (PDF-like payload) byte-for-byte", async () => {
    // PDF header + bytes that are invalid UTF-8. If the sidecar decodes the
    // upstream response via .text(), these bytes become U+FFFD (0xEF 0xBF 0xBD)
    // and the resulting buffer grows, breaking binary file downloads.
    const pdfLike = new Uint8Array([
      0x25,
      0x50,
      0x44,
      0x46,
      0x2d,
      0x31,
      0x2e,
      0x34, // "%PDF-1.4"
      0x0a, // LF
      0xff,
      0xfe,
      0x80,
      0xc0,
      0xc1, // invalid UTF-8 sequences
      0x00,
      0x01,
      0x02, // null bytes
      0x25,
      0x25,
      0x45,
      0x4f,
      0x46, // "%%EOF"
    ]);

    const fetchFn = mock(
      async () =>
        new Response(pdfLike, {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/files/abc/download",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const received = new Uint8Array(await res.arrayBuffer());
    expect(received.byteLength).toBe(pdfLike.byteLength);
    expect(received).toEqual(pdfLike);
  });

  it("does not corrupt binary response even when truncation is triggered", async () => {
    // 300 KB binary payload beyond the 256 KB default; the first 256 KB
    // must survive byte-for-byte.
    const total = 300_000;
    const cap = 256 * 1024;
    const payload = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      payload[i] = i % 256; // includes all byte values 0x00–0xff
    }

    const fetchFn = mock(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
    );
    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/blob",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Truncated")).toBe("true");
    const received = new Uint8Array(await res.arrayBuffer());
    expect(received.byteLength).toBe(cap);
    expect(received[0]).toBe(0x00);
    expect(received[0xff]).toBe(0xff);
    expect(received[cap - 1]).toBe((cap - 1) % 256);
  });
});

// --- binary roundtrip via /proxy ---
//
// End-to-end coverage of the `/proxy` byte path: the sidecar must
// preserve request and response bytes byte-for-byte (no UTF-8 decode,
// no `.text()` round-trip), respect the default 256 KB response cap,
// and honour `X-Max-Response-Size` up to ABSOLUTE_MAX_RESPONSE_SIZE.
// These tests pin the contract that the AFPS resolver in
// `packages/afps-runtime/src/resolvers/provider-tool.ts` depends on
// for binary upload/download (issues #149, #151, PR #260).

/** Deterministic pseudo-random byte stream — mulberry32 seeded PRNG. */
function makePseudoRandomBytes(size: number, seed = 0xc0_fe_ba_be): Uint8Array {
  const buf = new Uint8Array(size);
  let s = seed >>> 0;
  for (let i = 0; i < size; i++) {
    // mulberry32
    s = (s + 0x6d_2b_79_f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    buf[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return buf;
}

function sha256Hex(bytes: Uint8Array | ArrayBuffer): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

describe("binary roundtrip via /proxy", () => {
  it("upload: request body reaches upstream byte-for-byte", async () => {
    const payload = makePseudoRandomBytes(60_000, 0xa1_b2_c3_d4);
    const expectedHash = sha256Hex(payload);

    let capturedHash: string | null = null;
    let capturedLength = 0;
    const fetchFn = mock(async (_url: string, init: RequestInit) => {
      const body = init.body;
      // The proxy passes ArrayBuffer through buildBody() unchanged.
      if (body instanceof ArrayBuffer) {
        capturedLength = body.byteLength;
        capturedHash = sha256Hex(body);
      } else if (body instanceof Uint8Array) {
        capturedLength = body.byteLength;
        capturedHash = sha256Hex(body);
      } else {
        throw new Error(`unexpected body type: ${typeof body}`);
      }
      return new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } });
    });

    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "POST",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/upload",
        "Content-Type": "application/octet-stream",
      },
      body: payload,
    });

    expect(res.status).toBe(200);
    expect(capturedLength).toBe(payload.byteLength);
    expect(capturedHash).toBe(expectedHash);
  });

  it("download: response body returned byte-for-byte under default cap", async () => {
    const payload = makePseudoRandomBytes(60_000, 0xde_ad_be_ef);
    const expectedHash = sha256Hex(payload);

    const fetchFn = mock(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
    );

    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/download",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Truncated")).toBeNull();
    const received = new Uint8Array(await res.arrayBuffer());
    expect(received.byteLength).toBe(payload.byteLength);
    expect(sha256Hex(received)).toBe(expectedHash);
  });

  it("download: 400 KB upstream truncated to 256 KB default with X-Truncated", async () => {
    const cap = 256 * 1024;
    const payload = makePseudoRandomBytes(400_000, 0x12_34_56_78);
    const expectedPrefixHash = sha256Hex(payload.subarray(0, cap));

    const fetchFn = mock(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
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
    const received = new Uint8Array(await res.arrayBuffer());
    expect(received.byteLength).toBe(cap);
    expect(sha256Hex(received)).toBe(expectedPrefixHash);
  });

  it("download: X-Max-Response-Size=1_000_000 returns 600 KB untruncated", async () => {
    const payload = makePseudoRandomBytes(600_000, 0x9a_bc_de_f0);
    const expectedHash = sha256Hex(payload);

    const fetchFn = mock(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
    );

    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/largebin",
        "X-Max-Response-Size": "1000000",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Truncated")).toBeNull();
    const received = new Uint8Array(await res.arrayBuffer());
    expect(received.byteLength).toBe(payload.byteLength);
    expect(sha256Hex(received)).toBe(expectedHash);
  });

  it("download: X-Max-Response-Size=5_000_000 caps at 1 MB with truncation", async () => {
    const absoluteCap = 1_000_000;
    const payload = makePseudoRandomBytes(1_500_000, 0x55_aa_55_aa);
    const expectedPrefixHash = sha256Hex(payload.subarray(0, absoluteCap));

    const fetchFn = mock(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
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
    const received = new Uint8Array(await res.arrayBuffer());
    expect(received.byteLength).toBe(absoluteCap);
    expect(sha256Hex(received)).toBe(expectedPrefixHash);
  });
});

// --- /proxy streaming pass-through (PR-4) ---
//
// Covers the new opt-in streaming paths on /proxy:
//   - Response side: caller sets `X-Stream-Response: 1` to skip the
//     buffered/truncated path and pipe upstream bytes through. The
//     sidecar refuses up front via Content-Length when upstream
//     declares a body larger than MAX_STREAMED_BODY_SIZE.
//   - Request side: when content-length exceeds STREAMING_THRESHOLD
//     and the caller has not requested X-Substitute-Body, the sidecar
//     pipes the incoming body straight to upstream with duplex:
//     "half" — no buffering, no transparent 401-replay.
//   - 401 in streaming-request mode: credentials are refreshed but
//     the sidecar surfaces the original 401 with X-Auth-Refreshed:
//     true so the AFPS resolver retries idempotently.

describe("/proxy streaming response (X-Stream-Response: 1)", () => {
  it("pipes upstream body through without truncation when X-Stream-Response: 1", async () => {
    // 2 MB upstream body — well above the 256 KB / 1 MB buffered caps
    // — but well under the 100 MB streaming ceiling.
    const payload = makePseudoRandomBytes(2 * 1024 * 1024, 0xfa_ce_b0_0c);
    const expectedHash = sha256Hex(payload);

    const fetchFn = mock(
      async () =>
        new Response(payload, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(payload.byteLength),
          },
        }),
    );

    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/big-download",
        "X-Stream-Response": "1",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Truncated")).toBeNull();
    const received = new Uint8Array(await res.arrayBuffer());
    expect(received.byteLength).toBe(payload.byteLength);
    expect(sha256Hex(received)).toBe(expectedHash);
  });

  it("refuses with 413 when upstream Content-Length exceeds MAX_STREAMED_BODY_SIZE", async () => {
    // Don't actually send 200 MB through the test runner — the sidecar
    // gates on the upstream Content-Length header before reading the
    // body, so we can return an empty body with the oversized header.
    const fetchFn = mock(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(200_000_000),
          },
        }),
    );

    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/giant",
        "X-Stream-Response": "1",
      },
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("too large");
  });

  it("buffered path still applies when X-Stream-Response is absent (truncates at 256 KB)", async () => {
    // Sanity check — opting out of streaming preserves the legacy
    // truncated-buffered behavior covered elsewhere in this suite.
    const cap = 256 * 1024;
    const payload = makePseudoRandomBytes(400_000, 0x42_42_42_42);
    const fetchFn = mock(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
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
    const received = new Uint8Array(await res.arrayBuffer());
    expect(received.byteLength).toBe(cap);
  });

  it("truncated response emits both X-Truncated and X-Truncated-Size headers", async () => {
    const cap = 256 * 1024;
    const payload = makePseudoRandomBytes(400_000, 0x11_22_33_44);
    const fetchFn = mock(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
    );

    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/truncated-both-headers",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Truncated")).toBe("true");
    expect(res.headers.get("X-Truncated-Size")).toBe(String(cap));
    const received = new Uint8Array(await res.arrayBuffer());
    expect(received.byteLength).toBe(cap);
  });

  it("non-truncated response does not emit X-Truncated-Size", async () => {
    const payload = makePseudoRandomBytes(100 * 1024, 0xaa_bb_cc_dd); // 100 KB — under 256 KB cap
    const fetchFn = mock(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
    );

    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/small-no-truncation",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Truncated")).toBeNull();
    expect(res.headers.get("X-Truncated-Size")).toBeNull();
    const received = new Uint8Array(await res.arrayBuffer());
    expect(received.byteLength).toBe(100 * 1024);
  });
});

describe("/proxy streaming request (content-length > STREAMING_THRESHOLD)", () => {
  it("pipes the incoming body to upstream as a ReadableStream (no buffering)", async () => {
    // 2 MB upload — above the 1 MB STREAMING_THRESHOLD. The sidecar
    // must hand fetch() a ReadableStream rather than ArrayBuffer.
    const payload = makePseudoRandomBytes(2 * 1024 * 1024, 0xab_cd_ef_01);
    const expectedHash = sha256Hex(payload);

    let observedBodyType: string | null = null;
    let observedDuplex: string | null = null;
    let receivedHash: string | null = null;
    const fetchFn = mock(async (_url: string, init: RequestInit & { duplex?: string }) => {
      observedBodyType =
        init.body instanceof ReadableStream
          ? "ReadableStream"
          : init.body instanceof ArrayBuffer
            ? "ArrayBuffer"
            : init.body instanceof Uint8Array
              ? "Uint8Array"
              : typeof init.body;
      observedDuplex = init.duplex ?? null;
      // Drain the stream body to verify byte fidelity.
      if (init.body instanceof ReadableStream) {
        const reader = init.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            total += value.byteLength;
          }
        }
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.byteLength;
        }
        receivedHash = sha256Hex(merged);
      }
      return new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } });
    });

    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "POST",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/upload",
        "Content-Type": "application/octet-stream",
        "Content-Length": String(payload.byteLength),
      },
      body: payload,
    });

    expect(res.status).toBe(200);
    expect(observedBodyType).toBe("ReadableStream");
    expect(observedDuplex).toBe("half");
    expect(receivedHash).toBe(expectedHash);
  });

  it("refuses with 413 when content-length exceeds MAX_STREAMED_BODY_SIZE", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "POST",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/upload",
        "Content-Type": "application/octet-stream",
        // Above the 100 MB streaming cap.
        "Content-Length": String(200_000_000),
      },
      body: new Uint8Array([1, 2, 3]),
    });

    expect(res.status).toBe(413);
    expect(fetchFn).toHaveBeenCalledTimes(0);
  });

  it("buffered path still applies below STREAMING_THRESHOLD (substitute-body still works)", async () => {
    // 100 KB body — well under STREAMING_THRESHOLD, so the sidecar
    // buffers as before. Sanity check that we didn't break the
    // small-body case.
    const small = makePseudoRandomBytes(100_000, 0x11_22_33_44);
    let observedBodyType: string | null = null;
    const fetchFn = mock(async (_url: string, init: RequestInit) => {
      observedBodyType =
        init.body instanceof ReadableStream
          ? "ReadableStream"
          : init.body instanceof ArrayBuffer
            ? "ArrayBuffer"
            : init.body instanceof Uint8Array
              ? "Uint8Array"
              : typeof init.body;
      return new Response("ok", { status: 200 });
    });

    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "POST",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/upload",
        "Content-Type": "application/octet-stream",
        "Content-Length": String(small.byteLength),
      },
      body: small,
    });

    expect(res.status).toBe(200);
    // Hono / Bun fetch may surface an ArrayBuffer here — anything
    // non-stream is acceptable, the assertion is "NOT streamed".
    expect(observedBodyType).not.toBe("ReadableStream");
  });

  it("on 401 in streaming-request mode: surfaces 401 with X-Auth-Refreshed: true", async () => {
    // The sidecar consumed the body once on the first call — it
    // cannot replay it. Instead, it refreshes credentials and tells
    // the AFPS resolver via X-Auth-Refreshed so the next call will
    // succeed without manual user intervention.
    const big = makePseudoRandomBytes(2 * 1024 * 1024, 0xde_ad_be_ef);

    let upstreamCalls = 0;
    const fetchFn = mock(async (url: string, init: RequestInit) => {
      // Filter out the fire-and-forget /internal/connections/report-auth-failure
      // POST so the assertion below counts only true upstream calls.
      if (typeof url === "string" && url.includes("/internal/")) {
        return new Response("ok", { status: 200 });
      }
      // Drain stream body to mirror real fetch semantics.
      if (init.body instanceof ReadableStream) {
        const reader = init.body.getReader();
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
      upstreamCalls++;
      return new Response("auth", { status: 401, headers: { "Content-Type": "text/plain" } });
    });

    let refreshCalled = 0;
    const refreshCredentials = mock(async (): Promise<CredentialsResponse> => {
      refreshCalled++;
      return {
        credentials: { access_token: "rotated-456" },
        authorizedUris: ["https://api.example.com/**"],
        allowAllUris: false,
        credentialHeaderName: "Authorization",
        credentialHeaderPrefix: "Bearer",
        credentialFieldName: "access_token",
      };
    });

    const app = createApp(makeDeps({ fetchFn, refreshCredentials }));
    const res = await app.request("/proxy", {
      method: "POST",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/upload",
        "Content-Type": "application/octet-stream",
        "Content-Length": String(big.byteLength),
      },
      body: big,
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("X-Auth-Refreshed")).toBe("true");
    // Only ONE upstream call — the body was streamed and cannot be replayed.
    expect(upstreamCalls).toBe(1);
    expect(refreshCalled).toBe(1);
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
        runToken: "tok",
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

// --- Retry on 401 ---

describe("proxy retry-on-401", () => {
  it("retries with refreshed credentials on upstream 401", async () => {
    let callCount = 0;
    const deps = makeDeps({
      fetchCredentials: mock(
        async (): Promise<CredentialsResponse> => ({
          credentials: { access_token: "old-token" },
          authorizedUris: ["https://api.example.com/**"],
          allowAllUris: false,
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer",
          credentialFieldName: "access_token",
        }),
      ),
      refreshCredentials: mock(
        async (): Promise<CredentialsResponse> => ({
          credentials: { access_token: "new-token" },
          authorizedUris: ["https://api.example.com/**"],
          allowAllUris: false,
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer",
          credentialFieldName: "access_token",
        }),
      ),
      fetchFn: mock(async (_url: string, _init?: RequestInit) => {
        callCount++;
        const authHeader = (_init?.headers as Record<string, string>)?.["authorization"] ?? "";
        if (authHeader.includes("old-token")) {
          return new Response("Unauthorized", { status: 401 });
        }
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    });

    const app = createApp(deps);
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "@test/github",
        "X-Target": "https://api.example.com/user",
        Authorization: "Bearer {{access_token}}",
      },
    });

    expect(res.status).toBe(200);
    expect(callCount).toBe(2); // first call (401) + retry (200)
    expect(deps.refreshCredentials).toHaveBeenCalledTimes(1);
  });

  it("flags connection when retry also returns 401 after propagation delay", async () => {
    let reportCalled = false;
    const deps = makeDeps({
      refreshCredentials: mock(
        async (): Promise<CredentialsResponse> => ({
          credentials: { access_token: "still-bad" },
          authorizedUris: ["https://api.example.com/**"],
          allowAllUris: false,
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer",
          credentialFieldName: "access_token",
        }),
      ),
      fetchFn: mock(async (url: string, _init?: RequestInit) => {
        if (typeof url === "string" && url.includes("report-auth-failure")) {
          reportCalled = true;
          return new Response('{"flagged":true}', { status: 200 });
        }
        return new Response("Unauthorized", { status: 401 });
      }),
    });

    const app = createApp(deps);
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "@test/github",
        "X-Target": "https://api.example.com/user",
        Authorization: "Bearer {{access_token}}",
      },
    });

    expect(res.status).toBe(401);
    // Give the fire-and-forget report time to complete
    await new Promise((r) => setTimeout(r, 50));
    expect(reportCalled).toBe(true);
  });

  it("flags connection when refresh itself fails", async () => {
    let reportCalled = false;
    const deps = makeDeps({
      refreshCredentials: mock(async () => {
        throw new Error("invalid_grant");
      }),
      fetchFn: mock(async (url: string) => {
        if (typeof url === "string" && url.includes("report-auth-failure")) {
          reportCalled = true;
          return new Response('{"flagged":true}', { status: 200 });
        }
        return new Response("Unauthorized", { status: 401 });
      }),
    });

    const app = createApp(deps);
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "@test/github",
        "X-Target": "https://api.example.com/user",
        Authorization: "Bearer {{access_token}}",
      },
    });

    expect(res.status).toBe(401);
    await new Promise((r) => setTimeout(r, 50));
    expect(reportCalled).toBe(true);
  });

  it("does not retry when no refreshCredentials function is provided", async () => {
    let upstreamCallCount = 0;
    const deps = makeDeps({
      refreshCredentials: undefined,
      fetchFn: mock(async (url: string) => {
        if (typeof url === "string" && url.includes("report-auth-failure")) {
          return new Response('{"flagged":true}', { status: 200 });
        }
        upstreamCallCount++;
        return new Response("Unauthorized", { status: 401 });
      }),
    });

    const app = createApp(deps);
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "@test/github",
        "X-Target": "https://api.example.com/user",
        Authorization: "Bearer {{access_token}}",
      },
    });

    expect(res.status).toBe(401);
    expect(upstreamCallCount).toBe(1); // no retry, just the original call
  });

  it("retries POST requests with buffered body", async () => {
    let lastBody: string | undefined;
    const deps = makeDeps({
      refreshCredentials: mock(
        async (): Promise<CredentialsResponse> => ({
          credentials: { access_token: "new-token" },
          authorizedUris: ["https://api.example.com/**"],
          allowAllUris: false,
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer",
          credentialFieldName: "access_token",
        }),
      ),
      fetchFn: mock(async (_url: string, init?: RequestInit) => {
        const authHeader = (init?.headers as Record<string, string>)?.["authorization"] ?? "";
        if (authHeader.includes("old-token")) {
          return new Response("Unauthorized", { status: 401 });
        }
        if (init?.body instanceof ArrayBuffer) {
          lastBody = new TextDecoder().decode(init.body);
        } else if (typeof init?.body === "string") {
          lastBody = init.body;
        }
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
      fetchCredentials: mock(
        async (): Promise<CredentialsResponse> => ({
          credentials: { access_token: "old-token" },
          authorizedUris: ["https://api.example.com/**"],
          allowAllUris: false,
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer",
          credentialFieldName: "access_token",
        }),
      ),
    });

    const app = createApp(deps);
    const res = await app.request("/proxy", {
      method: "POST",
      headers: {
        "X-Provider": "@test/github",
        "X-Target": "https://api.example.com/issues",
        Authorization: "Bearer {{access_token}}",
        "Content-Type": "application/json",
      },
      body: '{"title":"test"}',
    });

    expect(res.status).toBe(200);
    expect(lastBody).toBe('{"title":"test"}');
  });
});

// --- ALL /proxy — chunked / unknown Content-Length → streaming path ---

describe("ALL /proxy — chunked upload without Content-Length", () => {
  it("engages streaming path when no Content-Length is declared (Task 4.4)", async () => {
    let bodyWasStream = false;
    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      bodyWasStream = init?.body instanceof ReadableStream;
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const app = createApp(makeDeps({ fetchFn }));
    // Omit Content-Length but add Transfer-Encoding: chunked — simulates a
    // chunked request where the body length is not known in advance.
    const res = await app.request("/proxy", {
      method: "POST",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/upload",
        "Transfer-Encoding": "chunked",
        // No Content-Length header — unknown length with chunked encoding
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello"));
          controller.close();
        },
      }),
    });

    expect(res.status).toBe(200);
    // The sidecar must have forwarded the body as a stream (streaming path)
    // because Transfer-Encoding: chunked was set without Content-Length.
    expect(bodyWasStream).toBe(true);
  });

  it("does NOT engage streaming path when X-Substitute-Body is set (buffered required)", async () => {
    let bodyWasStream = false;
    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      bodyWasStream = init?.body instanceof ReadableStream;
      return new Response("ok", { status: 200 });
    });

    const app = createApp(makeDeps({ fetchFn }));
    // X-Substitute-Body forces the buffered path even without Content-Length.
    const res = await app.request("/proxy", {
      method: "POST",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1/action",
        "X-Substitute-Body": "true",
        "Content-Type": "application/json",
      },
      body: '{"token":"{{access_token}}"}',
    });

    expect(res.status).toBe(200);
    expect(bodyWasStream).toBe(false);
  });
});
