import { describe, expect, mock, test } from "bun:test";
import { createApp, type AppDeps } from "../app.ts";
import type { CredentialsResponse } from "../helpers.ts";

function makeDeps(overrides?: Partial<AppDeps>): AppDeps {
  return {
    config: { platformApiUrl: "http://mock:3000", executionToken: "tok", proxyUrl: "" },
    fetchCredentials: mock(async (): Promise<CredentialsResponse> => ({
      credentials: { access_token: "test-123" },
      authorizedUris: ["https://api.example.com/*"],
      allowAllUris: false,
    })),
    cookieJar: new Map(),
    fetchFn: mock(async () => new Response('{"ok":true}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })),
    isReady: () => true,
    ...overrides,
  };
}

// --- GET /health ---

describe("GET /health", () => {
  test("returns 200 when ready", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("returns 503 when not ready", async () => {
    const app = createApp(makeDeps({ isReady: () => false }));
    const res = await app.request("/health");
    expect(res.status).toBe(503);
    const body = await res.json() as { status: string; proxy: string };
    expect(body.status).toBe("degraded");
  });

  test("response has correct content-type", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/health");
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

// --- POST /configure ---

describe("POST /configure", () => {
  test("updates executionToken", async () => {
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

  test("updates platformApiUrl", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ platformApiUrl: "http://new:4000" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(deps.config.platformApiUrl).toBe("http://new:4000");
  });

  test("updates proxyUrl to empty string", async () => {
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

  test("clears cookie jar", async () => {
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

  test("partial update keeps other fields", async () => {
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
});

// --- GET /execution-history ---

describe("GET /execution-history", () => {
  test("proxies to platform API", async () => {
    const fetchFn = mock(async () => new Response('{"entries":[]}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/execution-history");
    expect(res.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const url = (fetchFn.mock.calls[0] as [string])[0];
    expect(url).toBe("http://mock:3000/internal/execution-history");
  });

  test("forwards query string", async () => {
    const fetchFn = mock(async () => new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const app = createApp(makeDeps({ fetchFn }));
    await app.request("/execution-history?limit=10&offset=0");
    const url = (fetchFn.mock.calls[0] as [string])[0];
    expect(url).toContain("?limit=10&offset=0");
  });

  test("sends auth header", async () => {
    const fetchFn = mock(async () => new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const app = createApp(makeDeps({ fetchFn }));
    await app.request("/execution-history");
    const opts = (fetchFn.mock.calls[0] as [string, RequestInit])[1];
    expect((opts.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  test("returns 502 on fetch failure", async () => {
    const fetchFn = mock(async () => { throw new Error("connection refused"); });
    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/execution-history");
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("connection refused");
  });
});

// --- ALL /proxy — validation ---

describe("ALL /proxy — validation", () => {
  test("returns 400 without X-Provider", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/proxy", {
      method: "GET",
      headers: { "X-Target": "https://api.example.com/v1" },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("X-Provider");
  });

  test("returns 400 without X-Target", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/proxy", {
      method: "GET",
      headers: { "X-Provider": "gmail" },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("X-Target");
  });

  test("returns 400 for invalid provider ID", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/proxy", {
      method: "GET",
      headers: { "X-Provider": "../etc/passwd", "X-Target": "https://api.example.com/v1" },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Invalid X-Provider");
  });

  test("returns 502 when credential fetch fails", async () => {
    const fetchCredentials = mock(async () => { throw new Error("not found"); });
    const app = createApp(makeDeps({ fetchCredentials }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: { "X-Provider": "gmail", "X-Target": "https://api.example.com/v1" },
    });
    expect(res.status).toBe(502);
  });

  test("returns 400 for unresolved placeholders in URL", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://{{unknown_host}}/api",
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Unresolved placeholders in URL");
  });

  test("returns 403 when URL not in authorizedUris", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://evil.com/steal",
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("not authorized");
  });

  test("returns 403 when allowAllUris but URL targets blocked host", async () => {
    const fetchCredentials = mock(async (): Promise<CredentialsResponse> => ({
      credentials: { access_token: "t" },
      authorizedUris: null,
      allowAllUris: true,
    }));
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

  test("returns 403 when no authorizedUris and URL targets blocked host", async () => {
    const fetchCredentials = mock(async (): Promise<CredentialsResponse> => ({
      credentials: { access_token: "t" },
      authorizedUris: null,
      allowAllUris: false,
    }));
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

  test("returns 400 for unresolved placeholders in headers", async () => {
    const fetchCredentials = mock(async (): Promise<CredentialsResponse> => ({
      credentials: {},
      authorizedUris: ["https://api.example.com/*"],
      allowAllUris: false,
    }));
    const app = createApp(makeDeps({ fetchCredentials }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1",
        "Authorization": "Bearer {{missing_token}}",
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Unresolved placeholders in header");
  });

  test("returns 400 for unresolved placeholders in X-Proxy", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1",
        "X-Proxy": "http://{{missing_proxy}}:8080",
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Unresolved placeholders in X-Proxy");
  });
});

// --- ALL /proxy — forwarding ---

describe("ALL /proxy — forwarding", () => {
  test("forwards GET request to target", async () => {
    const fetchFn = mock(async () => new Response('{"data":1}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
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

  test("forwards POST request with body", async () => {
    const fetchFn = mock(async () => new Response('{"created":true}', {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
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

  test("substitutes variables in URL", async () => {
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

  test("substitutes variables in body when X-Substitute-Body set", async () => {
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

  test("returns 400 for unresolved placeholders in body", async () => {
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
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Unresolved placeholders in body");
  });

  test("returns 502 when target request fails", async () => {
    const fetchFn = mock(async () => { throw new Error("ECONNREFUSED"); });
    const app = createApp(makeDeps({ fetchFn }));
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1",
      },
    });
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("ECONNREFUSED");
  });

  test("truncates response over MAX_RESPONSE_SIZE", async () => {
    const largeBody = "x".repeat(60_000);
    const fetchFn = mock(async () => new Response(largeBody, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    }));
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

  test("stores Set-Cookie headers in cookie jar", async () => {
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

  test("injects stored cookies from cookie jar", async () => {
    const deps = makeDeps();
    deps.cookieJar.set("gmail", ["sid=abc123"]);
    const fetchFn = mock(async () => new Response("ok", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    }));
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

  test("strips routing headers from forwarded request", async () => {
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

  test("substitutes variables in headers", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const app = createApp(makeDeps({ fetchFn }));
    await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1",
        "Authorization": "Bearer {{access_token}}",
      },
    });
    const opts = (fetchFn.mock.calls[0] as [string, RequestInit])[1];
    const headers = opts.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer test-123");
  });

  test("uses X-Proxy header for proxy resolution", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const app = createApp(makeDeps({ fetchFn }));
    await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "gmail",
        "X-Target": "https://api.example.com/v1",
        "X-Proxy": "http://myproxy:8080",
      },
    });
    const opts = (fetchFn.mock.calls[0] as [string, RequestInit])[1];
    // @ts-expect-error proxy is Bun-specific
    expect(opts.proxy).toBe("http://myproxy:8080");
  });
});
