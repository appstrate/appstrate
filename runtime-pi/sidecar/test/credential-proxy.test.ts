// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the shared credential-proxy core.
 *
 * The MCP `provider_call` tool delegates here. This file pins the
 * structured args/result surface so MCP-only regressions (e.g. dropping
 * a result branch) are caught without needing a Hono context.
 */

import { describe, it, expect, mock } from "bun:test";
import { executeProviderCall, type ProviderCallDeps } from "../credential-proxy.ts";
import type { CredentialsResponse } from "../helpers.ts";

function makeDeps(overrides: Partial<ProviderCallDeps> = {}): ProviderCallDeps {
  return {
    config: { runToken: "rt", platformApiUrl: "http://platform" },
    cookieJar: new Map(),
    fetchFn: mock(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch,
    fetchCredentials: mock(
      async (): Promise<CredentialsResponse> => ({
        credentials: { access_token: "tok-123" },
        authorizedUris: ["https://api.example.com/**"],
        allowAllUris: false,
        credentialHeaderName: "Authorization",
        credentialHeaderPrefix: "Bearer",
        credentialFieldName: "access_token",
      }),
    ),
    reportedAuthFailures: new Set<string>(),
    ...overrides,
  };
}

describe("executeProviderCall — structured failures", () => {
  it("rejects malformed providerId without touching credentials", async () => {
    const fetchCredentials = mock(async () => ({}) as never);
    const result = await executeProviderCall(
      {
        providerId: "../traversal",
        targetUrl: "https://api.example.com/x",
        method: "GET",
        callerHeaders: {},
        body: { kind: "none" },
      },
      makeDeps({ fetchCredentials }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/X-Provider/);
    }
    expect(fetchCredentials).not.toHaveBeenCalled();
  });

  it("returns 400 on unresolved URL placeholders", async () => {
    const result = await executeProviderCall(
      {
        providerId: "gmail",
        targetUrl: "https://api.example.com/{{missing}}",
        method: "GET",
        callerHeaders: {},
        body: { kind: "none" },
      },
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Unresolved placeholders in URL/);
  });

  it("returns 403 when the URL is not in authorizedUris", async () => {
    const result = await executeProviderCall(
      {
        providerId: "gmail",
        targetUrl: "https://other.example.com/x",
        method: "GET",
        callerHeaders: {},
        body: { kind: "none" },
      },
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error).toMatch(/not authorized/);
    }
  });
});

describe("executeProviderCall — happy path", () => {
  it("forwards credentials, captures cookies, and returns the upstream response", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"data":42}', {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": "sess=abc; Path=/; HttpOnly",
          },
        }),
    );
    const deps = makeDeps({ fetchFn: fetchFn as unknown as typeof fetch });
    const result = await executeProviderCall(
      {
        providerId: "gmail",
        targetUrl: "https://api.example.com/messages",
        method: "GET",
        callerHeaders: { "X-Custom": "x" },
        body: { kind: "none" },
      },
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.status).toBe(200);
      const text = await result.response.text();
      expect(text).toBe('{"data":42}');
      expect(result.authRefreshed).toBe(false);
    }
    expect(deps.cookieJar.get("gmail")).toEqual(["sess=abc"]);
    // Verify Authorization was server-side injected.
    const callArgs = fetchFn.mock.calls[0]!;
    const init = callArgs[1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers["Authorization"]).toBe("Bearer tok-123");
    expect(init.headers["X-Custom"]).toBe("x");
  });
});

describe("executeProviderCall — 401 retry path", () => {
  it("refreshes credentials and replays the buffered request once", async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response('{"error":"expired"}', {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const refreshCredentials = mock(
      async (): Promise<CredentialsResponse> => ({
        credentials: { access_token: "tok-fresh" },
        authorizedUris: ["https://api.example.com/**"],
        allowAllUris: false,
        credentialHeaderName: "Authorization",
        credentialHeaderPrefix: "Bearer",
        credentialFieldName: "access_token",
      }),
    );
    const deps = makeDeps({
      fetchFn: fetchFn as unknown as typeof fetch,
      refreshCredentials,
    });
    const result = await executeProviderCall(
      {
        providerId: "gmail",
        targetUrl: "https://api.example.com/x",
        method: "GET",
        callerHeaders: {},
        body: { kind: "none" },
      },
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.response.status).toBe(200);
    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(callCount).toBe(2);
    expect(deps.reportedAuthFailures.has("gmail")).toBe(false);
  });

  it("does NOT replay a streaming-request body on 401", async () => {
    let upstreamCalls = 0;
    const fetchFn = mock(async (url: string | URL) => {
      const target = typeof url === "string" ? url : url.toString();
      if (target.startsWith("https://api.example.com")) upstreamCalls += 1;
      return new Response("expired", { status: 401 });
    });
    const refreshCredentials = mock(
      async (): Promise<CredentialsResponse> => ({
        credentials: { access_token: "tok-fresh" },
        authorizedUris: ["https://api.example.com/**"],
        allowAllUris: false,
        credentialHeaderName: "Authorization",
        credentialHeaderPrefix: "Bearer",
        credentialFieldName: "access_token",
      }),
    );
    const deps = makeDeps({
      fetchFn: fetchFn as unknown as typeof fetch,
      refreshCredentials,
    });
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.close();
      },
    });
    const result = await executeProviderCall(
      {
        providerId: "gmail",
        targetUrl: "https://api.example.com/upload",
        method: "POST",
        callerHeaders: {},
        body: { kind: "streaming", stream },
      },
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.status).toBe(401);
      expect(result.authRefreshed).toBe(true);
    }
    expect(upstreamCalls).toBe(1);
    expect(refreshCredentials).toHaveBeenCalledTimes(1);
  });
});

describe("executeProviderCall — multi-hop redirect cookie capture (#473)", () => {
  /**
   * Bug repro: in multi-step OAuth/CAS flows the session cookie is
   * often dropped on an intermediate 302. With Bun's native
   * `redirect: "follow"` only the final hop's Set-Cookie is exposed,
   * so the jar misses the mid-hop session cookie. After the fix we
   * follow redirects manually and merge cookies from every hop.
   */
  it("captures Set-Cookie from intermediate hops", async () => {
    let calls = 0;
    const fetchFn = mock(async (url: string | URL) => {
      calls += 1;
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/login")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://api.example.com/callback", "set-cookie": "step1=A" },
        });
      }
      if (u.endsWith("/callback")) {
        // Intermediate hop — its cookie is the one that used to be lost.
        return new Response(null, {
          status: 302,
          headers: { location: "https://api.example.com/home", "set-cookie": "session=XYZ" },
        });
      }
      return new Response("ok", {
        status: 200,
        headers: { "set-cookie": "last=Z" },
      });
    });
    const deps = makeDeps({ fetchFn: fetchFn as unknown as typeof fetch });
    const result = await executeProviderCall(
      {
        providerId: "kijiji",
        targetUrl: "https://api.example.com/login",
        method: "GET",
        callerHeaders: {},
        body: { kind: "none" },
      },
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.response.status).toBe(200);
    expect(calls).toBe(3);
    const jar = deps.cookieJar.get("kijiji");
    // Pre-fix: ["step1=A", "last=Z"] — session=XYZ is missing.
    // Post-fix: all three cookies merged into the jar.
    expect(jar).toContain("step1=A");
    expect(jar).toContain("session=XYZ");
    expect(jar).toContain("last=Z");
  });

  it("re-injects the growing jar as Cookie header on each next hop", async () => {
    const cookieHeadersSeen: (string | null)[] = [];
    const fetchFn = mock(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      const headers = new Headers(init?.headers);
      cookieHeadersSeen.push(headers.get("cookie"));
      if (u.endsWith("/a")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://api.example.com/b", "set-cookie": "first=1" },
        });
      }
      if (u.endsWith("/b")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://api.example.com/c", "set-cookie": "second=2" },
        });
      }
      return new Response("ok", { status: 200 });
    });
    const deps = makeDeps({ fetchFn: fetchFn as unknown as typeof fetch });
    await executeProviderCall(
      {
        providerId: "demo",
        targetUrl: "https://api.example.com/a",
        method: "GET",
        callerHeaders: {},
        body: { kind: "none" },
      },
      deps,
    );
    expect(cookieHeadersSeen.length).toBe(3);
    expect(cookieHeadersSeen[0]).toBeNull();
    expect(cookieHeadersSeen[1]).toBe("first=1");
    // Both cookies sent on the third hop (jar grew across hops).
    expect(cookieHeadersSeen[2]).toContain("first=1");
    expect(cookieHeadersSeen[2]).toContain("second=2");
  });

  it("downgrades method to GET and drops body on 301/302/303", async () => {
    const observed: { method: string; body: unknown; contentType: string | null }[] = [];
    const fetchFn = mock(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      const headers = new Headers(init?.headers);
      observed.push({
        method: init?.method ?? "GET",
        body: init?.body,
        contentType: headers.get("content-type"),
      });
      if (u.endsWith("/post")) {
        return new Response(null, {
          status: 303,
          headers: { location: "https://api.example.com/result" },
        });
      }
      return new Response("done", { status: 200 });
    });
    const deps = makeDeps({ fetchFn: fetchFn as unknown as typeof fetch });
    const result = await executeProviderCall(
      {
        providerId: "demo",
        targetUrl: "https://api.example.com/post",
        method: "POST",
        callerHeaders: { "content-type": "application/json" },
        body: {
          kind: "buffered",
          bytes: new TextEncoder().encode('{"x":1}').buffer as ArrayBuffer,
          text: '{"x":1}',
        },
      },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(observed[0]!.method).toBe("POST");
    expect(observed[1]!.method).toBe("GET");
    expect(observed[1]!.body).toBeUndefined();
    expect(observed[1]!.contentType).toBeNull();
  });

  it("preserves method and body on 307/308", async () => {
    const observed: { method: string; body: unknown }[] = [];
    const fetchFn = mock(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      observed.push({ method: init?.method ?? "GET", body: init?.body });
      if (u.endsWith("/post")) {
        return new Response(null, {
          status: 307,
          headers: { location: "https://api.example.com/result" },
        });
      }
      return new Response("done", { status: 200 });
    });
    const deps = makeDeps({ fetchFn: fetchFn as unknown as typeof fetch });
    const result = await executeProviderCall(
      {
        providerId: "demo",
        targetUrl: "https://api.example.com/post",
        method: "POST",
        callerHeaders: { "content-type": "application/json" },
        body: {
          kind: "buffered",
          bytes: new TextEncoder().encode('{"x":1}').buffer as ArrayBuffer,
          text: '{"x":1}',
        },
      },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(observed[0]!.method).toBe("POST");
    expect(observed[1]!.method).toBe("POST");
    expect(observed[1]!.body).toBeDefined();
  });

  it("throws on redirect chains exceeding MAX_REDIRECTS", async () => {
    const fetchFn = mock(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://api.example.com/loop" },
        }),
    );
    const deps = makeDeps({ fetchFn: fetchFn as unknown as typeof fetch });
    const result = await executeProviderCall(
      {
        providerId: "demo",
        targetUrl: "https://api.example.com/loop",
        method: "GET",
        callerHeaders: {},
        body: { kind: "none" },
      },
      deps,
    );
    // Surfaces as a structured upstream failure (wrapped by wrapFetchError).
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(502);
  });

  it("streaming bodies still use native fetch and only capture final-hop cookies", async () => {
    const fetchFn = mock(
      async () =>
        new Response("ok", {
          status: 200,
          headers: { "set-cookie": "final=F" },
        }),
    );
    const deps = makeDeps({ fetchFn: fetchFn as unknown as typeof fetch });
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.close();
      },
    });
    const result = await executeProviderCall(
      {
        providerId: "demo",
        targetUrl: "https://api.example.com/upload",
        method: "POST",
        callerHeaders: {},
        body: { kind: "streaming", stream },
      },
      deps,
    );
    expect(result.ok).toBe(true);
    // Native fetch called once with redirect: "follow" (default).
    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    expect(init.redirect).not.toBe("manual");
    expect(deps.cookieJar.get("demo")).toEqual(["final=F"]);
  });
});
