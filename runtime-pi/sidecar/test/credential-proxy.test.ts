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

describe("executeProviderCall — x-tlsClientByUrl dispatch (issue #403)", () => {
  it("routes a URL matching a curl pattern through curlFetchFn, not fetchFn", async () => {
    const fetchFn = mock(async () => new Response("from-fetch", { status: 200 }));
    const curlFetchFn = mock(async () => new Response("from-curl", { status: 200 }));
    const fetchCredentials = mock(
      async (): Promise<CredentialsResponse> => ({
        credentials: { access_token: "tok-123" },
        authorizedUris: ["https://api.example.com/**"],
        allowAllUris: false,
        credentialHeaderName: "Authorization",
        credentialHeaderPrefix: "Bearer",
        credentialFieldName: "access_token",
        tlsClientByUrl: [{ pattern: "https://api.example.com/**", client: "curl" }],
      }),
    );
    const deps = makeDeps({
      fetchFn: fetchFn as unknown as typeof fetch,
      curlFetchFn: curlFetchFn as unknown as typeof fetch,
      fetchCredentials,
    });
    const result = await executeProviderCall(
      {
        providerId: "gmail",
        targetUrl: "https://api.example.com/messages",
        method: "GET",
        callerHeaders: {},
        body: { kind: "none" },
      },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(curlFetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).not.toHaveBeenCalled();
    if (result.ok) {
      expect(await result.response.text()).toBe("from-curl");
    }
    // Credential header still server-side injected — the curl path must
    // see Authorization just like the fetch path.
    const curlInit = curlFetchFn.mock.calls[0]![1] as {
      headers: Record<string, string>;
    };
    expect(curlInit.headers["Authorization"]).toBe("Bearer tok-123");
  });

  it("non-matching URL uses default fetchFn, not curlFetchFn", async () => {
    const fetchFn = mock(async () => new Response("from-fetch", { status: 200 }));
    const curlFetchFn = mock(async () => new Response("from-curl", { status: 200 }));
    const fetchCredentials = mock(
      async (): Promise<CredentialsResponse> => ({
        credentials: { access_token: "tok-123" },
        authorizedUris: ["https://api.example.com/**", "https://other.example.com/**"],
        allowAllUris: false,
        credentialHeaderName: "Authorization",
        credentialHeaderPrefix: "Bearer",
        credentialFieldName: "access_token",
        // Only api.example.com is curl-bound; other.example.com falls
        // through to the default fetch.
        tlsClientByUrl: [{ pattern: "https://api.example.com/**", client: "curl" }],
      }),
    );
    const deps = makeDeps({
      fetchFn: fetchFn as unknown as typeof fetch,
      curlFetchFn: curlFetchFn as unknown as typeof fetch,
      fetchCredentials,
    });
    const result = await executeProviderCall(
      {
        providerId: "gmail",
        targetUrl: "https://other.example.com/x",
        method: "GET",
        callerHeaders: {},
        body: { kind: "none" },
      },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(curlFetchFn).not.toHaveBeenCalled();
  });

  it("falls back to fetchFn when no tlsClientByUrl is declared", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const curlFetchFn = mock(async () => new Response("never", { status: 200 }));
    const deps = makeDeps({
      fetchFn: fetchFn as unknown as typeof fetch,
      curlFetchFn: curlFetchFn as unknown as typeof fetch,
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
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(curlFetchFn).not.toHaveBeenCalled();
  });

  it('explicit client: "undici" pattern is a no-op (uses fetchFn)', async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const curlFetchFn = mock(async () => new Response("never", { status: 200 }));
    const fetchCredentials = mock(
      async (): Promise<CredentialsResponse> => ({
        credentials: { access_token: "tok-123" },
        authorizedUris: ["https://api.example.com/**"],
        allowAllUris: false,
        credentialHeaderName: "Authorization",
        credentialHeaderPrefix: "Bearer",
        credentialFieldName: "access_token",
        tlsClientByUrl: [{ pattern: "https://api.example.com/**", client: "undici" }],
      }),
    );
    const deps = makeDeps({
      fetchFn: fetchFn as unknown as typeof fetch,
      curlFetchFn: curlFetchFn as unknown as typeof fetch,
      fetchCredentials,
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
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(curlFetchFn).not.toHaveBeenCalled();
  });
});
