// SPDX-License-Identifier: Apache-2.0

/**
 * Integration coverage for the sidecar's `/llm/*` OAuth path
 * (SPEC §5.3–5.5).
 *
 * Exercises the full lifecycle: token cache fetch → identity injection
 * → URL rewriting → body transform → upstream → 401 retry → adaptive
 * beta retry. Mocks both the platform's `/internal/oauth-token/*`
 * endpoints and the upstream LLM provider via a single `fetchFn`
 * dispatcher.
 */

import { describe, it, expect, mock } from "bun:test";
import { createApp, type AppDeps } from "../app.ts";
import { OAuthTokenCache } from "../oauth-token-cache.ts";
import type { OAuthTokenResponse } from "@appstrate/core/sidecar-types";
import type { CredentialsResponse, LlmProxyOauthConfig } from "../helpers.ts";

const PLATFORM_API = "http://platform-mock:3000";
const RUN_TOKEN = "run-tok";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface MockUpstream {
  /** Called for every fetch issued through the cache or `/llm/*`. */
  fetchFn: ReturnType<typeof mock>;
  calls: FetchCall[];
}

function buildOAuthTokenResponse(overrides: Partial<OAuthTokenResponse> = {}): OAuthTokenResponse {
  return {
    accessToken: "oat-fresh-token",
    expiresAt: Date.now() + 60 * 60_000,
    apiShape: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    providerId: "claude-code",
    ...overrides,
  };
}

function setupFetchMock(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: FetchCall[] = [];
  const fetchFn = mock(async (url: unknown, init?: RequestInit) => {
    const u = typeof url === "string" ? url : (url as URL).toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headers[k] = v;
    }
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url: u, method: init?.method ?? "GET", headers, body });
    return handler(u, init ?? {});
  });
  return { fetchFn, calls };
}

function makeDepsWithCache(upstream: MockUpstream): AppDeps {
  const cache = new OAuthTokenCache({
    getPlatformApiUrl: () => PLATFORM_API,
    getRunToken: () => RUN_TOKEN,
    fetchFn: upstream.fetchFn as unknown as typeof fetch,
  });
  return {
    config: {
      platformApiUrl: PLATFORM_API,
      runToken: RUN_TOKEN,
    },
    fetchCredentials: mock(
      async (): Promise<CredentialsResponse> => ({
        credentials: { access_token: "stub" },
        authorizedUris: [],
        allowAllUris: false,
        credentialHeaderName: "Authorization",
        credentialHeaderPrefix: "Bearer",
        credentialFieldName: "access_token",
      }),
    ),
    cookieJar: new Map(),
    fetchFn: upstream.fetchFn as unknown as typeof fetch,
    isReady: () => true,
    oauthTokenCache: cache,
  };
}

const CLAUDE_OAUTH: LlmProxyOauthConfig = {
  authMode: "oauth",
  baseUrl: "https://api.anthropic.com",
  credentialId: "conn-abc",
  providerId: "claude-code",
};

const CODEX_OAUTH: LlmProxyOauthConfig = {
  authMode: "oauth",
  baseUrl: "https://chatgpt.com/backend-api",
  credentialId: "conn-codex",
  providerId: "codex",
  forceStream: true,
  forceStore: false,
};

describe("/llm/* OAuth — Claude path", () => {
  it("injects bearer + identity headers and prepends Claude Code identity to body", async () => {
    const upstream = setupFetchMock((url) => {
      if (url.startsWith(PLATFORM_API)) {
        return new Response(JSON.stringify(buildOAuthTokenResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response('{"id":"msg_1"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const deps = makeDepsWithCache(upstream);
    deps.config.llm = CLAUDE_OAUTH;
    const app = createApp(deps);

    const res = await app.request("/llm/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });
    expect(res.status).toBe(200);

    // First call → platform; second call → upstream
    expect(upstream.calls).toHaveLength(2);
    const upstreamCall = upstream.calls[1]!;
    expect(upstreamCall.url).toBe("https://api.anthropic.com/v1/messages");
    expect(upstreamCall.headers["authorization"]).toBe("Bearer oat-fresh-token");
    expect(upstreamCall.headers["x-app"]).toBe("cli");
    expect(upstreamCall.headers["accept"]).toBe("application/json");
    expect(upstreamCall.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");

    // Body has Claude Code identity prepended into `system`
    const body = JSON.parse(upstreamCall.body!);
    expect(body.system).toEqual([
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
    ]);
  });

  it("retries once on 401 with a force-refreshed token", async () => {
    let upstreamCallNumber = 0;
    const upstream = setupFetchMock((url) => {
      if (url.startsWith(PLATFORM_API)) {
        // Both /token and /refresh return a token, but /refresh returns a fresh one
        const isRefresh = url.endsWith("/refresh");
        return new Response(
          JSON.stringify(
            buildOAuthTokenResponse({
              accessToken: isRefresh ? "oat-after-refresh" : "oat-stale",
            }),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      upstreamCallNumber++;
      if (upstreamCallNumber === 1) {
        return new Response('{"error":"invalid_token"}', {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response('{"id":"msg_after_retry"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const deps = makeDepsWithCache(upstream);
    deps.config.llm = CLAUDE_OAUTH;
    const app = createApp(deps);

    const res = await app.request("/llm/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("msg_after_retry");

    // Calls: /token, upstream(401), /refresh, upstream(200) = 4
    expect(upstream.calls).toHaveLength(4);
    const upstreamCalls = upstream.calls.filter((c) => !c.url.startsWith(PLATFORM_API));
    expect(upstreamCalls).toHaveLength(2);
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer oat-stale");
    expect(upstreamCalls[1]!.headers["authorization"]).toBe("Bearer oat-after-refresh");
  });

  it("propagates 401 + needsReconnection when refresh returns 410", async () => {
    let upstreamCallNumber = 0;
    const upstream = setupFetchMock((url) => {
      if (url.startsWith(PLATFORM_API)) {
        if (url.endsWith("/refresh")) {
          return new Response(JSON.stringify({ detail: "revoked" }), {
            status: 410,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(buildOAuthTokenResponse({ accessToken: "stale" })), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      upstreamCallNumber++;
      return new Response('{"error":"invalid_token"}', {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });
    const deps = makeDepsWithCache(upstream);
    deps.config.llm = CLAUDE_OAUTH;
    const app = createApp(deps);

    const res = await app.request("/llm/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { needsReconnection: boolean };
    expect(body.needsReconnection).toBe(true);
    // Only the first upstream call happened — the retry was aborted by the 410
    expect(upstreamCallNumber).toBe(1);
  });

  it("returns 401 + needsReconnection if initial token fetch returns 410", async () => {
    const upstream = setupFetchMock(
      () =>
        new Response(JSON.stringify({ detail: "needs reconnection" }), {
          status: 410,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const deps = makeDepsWithCache(upstream);
    deps.config.llm = CLAUDE_OAUTH;
    const app = createApp(deps);

    const res = await app.request("/llm/v1/messages", { method: "POST" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { needsReconnection: boolean };
    expect(body.needsReconnection).toBe(true);
  });

  it("strips context-1m beta on 'out of extra usage' 400 and retries", async () => {
    let upstreamCalls = 0;
    const upstream = setupFetchMock((url) => {
      if (url.startsWith(PLATFORM_API)) {
        return new Response(JSON.stringify(buildOAuthTokenResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      upstreamCalls++;
      if (upstreamCalls === 1) {
        return new Response(
          JSON.stringify({ error: { message: "out of extra usage for long context beta" } }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response('{"id":"msg_after_beta_strip"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const deps = makeDepsWithCache(upstream);
    deps.config.llm = CLAUDE_OAUTH;
    const app = createApp(deps);

    const res = await app.request("/llm/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-beta": "context-1m-2025-08-07, other-beta-x",
      },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("msg_after_beta_strip");

    const upstreamFetches = upstream.calls.filter((c) => !c.url.startsWith(PLATFORM_API));
    expect(upstreamFetches).toHaveLength(2);
    // Second call has the long-context beta stripped
    expect(upstreamFetches[1]!.headers["anthropic-beta"]).toBe("other-beta-x");
  });
});

describe("/llm/* OAuth — Codex path", () => {
  it("forwards to /codex/responses, injects chatgpt-account-id + WAF-safe UA, and coerces stream/store flags", async () => {
    const upstream = setupFetchMock((url) => {
      if (url.startsWith(PLATFORM_API)) {
        return new Response(
          JSON.stringify(
            buildOAuthTokenResponse({
              providerId: "codex",
              apiShape: "openai-codex-responses",
              baseUrl: "https://chatgpt.com/backend-api",
              forceStream: true,
              forceStore: false,
              accountId: "acc_007",
            }),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const deps = makeDepsWithCache(upstream);
    deps.config.llm = CODEX_OAUTH;
    const app = createApp(deps);

    // pi-ai's openai-codex-responses provider hits `${baseUrl}/codex/responses`
    // natively — the sidecar receives the already-resolved path.
    const res = await app.request("/llm/codex/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        stream: false,
        store: true,
        input: "hello",
      }),
    });
    expect(res.status).toBe(200);

    const upstreamCall = upstream.calls.find((c) => !c.url.startsWith(PLATFORM_API))!;
    expect(upstreamCall.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(upstreamCall.headers["authorization"]).toBe("Bearer oat-fresh-token");
    expect(upstreamCall.headers["chatgpt-account-id"]).toBe("acc_007");
    expect(upstreamCall.headers["originator"]).toBe("pi");
    expect(upstreamCall.headers["openai-beta"]).toBe("responses=experimental");
    // WAF-safe UA must be set — Cloudflare on chatgpt.com challenges the
    // OpenAI SDK's default `OpenAI/JS …` UA with `cf-mitigated: challenge`.
    expect(upstreamCall.headers["user-agent"]).toBe("pi (linux x86_64)");
    expect(upstreamCall.headers["accept"]).toBe("text/event-stream");

    const body = JSON.parse(upstreamCall.body!);
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
  });
});

describe("/llm/* OAuth — provider failure modes (Phase 8)", () => {
  it("propagates 429 rate limit verbatim (no retry, Retry-After preserved)", async () => {
    let upstreamCalls = 0;
    const upstream = setupFetchMock((url) => {
      if (url.startsWith(PLATFORM_API)) {
        return new Response(JSON.stringify(buildOAuthTokenResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      upstreamCalls++;
      return new Response(
        JSON.stringify({ error: { type: "rate_limit_error", message: "rate limited" } }),
        {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "30" },
        },
      );
    });
    const deps = makeDepsWithCache(upstream);
    deps.config.llm = CLAUDE_OAUTH;
    const app = createApp(deps);

    const res = await app.request("/llm/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    // Single upstream call: 429 must NOT trigger the 401-retry path
    expect(upstreamCalls).toBe(1);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("rate_limit_error");
  });

  it("propagates 5xx upstream error verbatim", async () => {
    let upstreamCalls = 0;
    const upstream = setupFetchMock((url) => {
      if (url.startsWith(PLATFORM_API)) {
        return new Response(JSON.stringify(buildOAuthTokenResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      upstreamCalls++;
      return new Response('{"error":"upstream service unavailable"}', {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    });
    const deps = makeDepsWithCache(upstream);
    deps.config.llm = CLAUDE_OAUTH;
    const app = createApp(deps);

    const res = await app.request("/llm/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(503);
    expect(upstreamCalls).toBe(1);
  });

  it("does NOT retry indefinitely on repeated 401s — second 401 is propagated", async () => {
    let upstreamCalls = 0;
    const upstream = setupFetchMock((url) => {
      if (url.startsWith(PLATFORM_API)) {
        return new Response(JSON.stringify(buildOAuthTokenResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      upstreamCalls++;
      return new Response('{"error":"invalid_token"}', {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });
    const deps = makeDepsWithCache(upstream);
    deps.config.llm = CLAUDE_OAUTH;
    const app = createApp(deps);

    const res = await app.request("/llm/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(401);
    // Exactly 2 upstream calls: original + the single retry. Not 3, not 1.
    expect(upstreamCalls).toBe(2);
  });

  it("returns a structured 502 when the upstream provider is unreachable", async () => {
    const upstream = setupFetchMock((url) => {
      if (url.startsWith(PLATFORM_API)) {
        return new Response(JSON.stringify(buildOAuthTokenResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error("ENETUNREACH");
    });
    const deps = makeDepsWithCache(upstream);
    deps.config.llm = CLAUDE_OAUTH;
    const app = createApp(deps);

    const res = await app.request("/llm/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    // Sidecar must surface a 502 (or 5xx) rather than crash; agent will see a clean error.
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.status).toBeLessThan(600);
  });

  it("returns a 5xx when the platform's /internal/oauth-token call fails (not a hard crash)", async () => {
    const upstream = setupFetchMock((url) => {
      if (url.startsWith(PLATFORM_API)) {
        return new Response(JSON.stringify({ detail: "platform DB down" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("ok", { status: 200 });
    });
    const deps = makeDepsWithCache(upstream);
    deps.config.llm = CLAUDE_OAUTH;
    const app = createApp(deps);

    const res = await app.request("/llm/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe("/llm/* OAuth — config errors", () => {
  it("returns 503 when oauthTokenCache dep is missing", async () => {
    const upstream = setupFetchMock(() => new Response("ok", { status: 200 }));
    const deps = makeDepsWithCache(upstream);
    delete deps.oauthTokenCache;
    deps.config.llm = CLAUDE_OAUTH;
    const app = createApp(deps);
    const res = await app.request("/llm/v1/messages", { method: "POST" });
    expect(res.status).toBe(503);
  });

  it("returns 403 when resolved baseUrl is blocked", async () => {
    const upstream = setupFetchMock((url) => {
      if (url.startsWith(PLATFORM_API)) {
        return new Response(
          JSON.stringify(buildOAuthTokenResponse({ baseUrl: "http://10.0.0.1" })),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("ok", { status: 200 });
    });
    const deps = makeDepsWithCache(upstream);
    deps.config.llm = CLAUDE_OAUTH;
    const app = createApp(deps);
    const res = await app.request("/llm/v1/messages", { method: "POST" });
    expect(res.status).toBe(403);
  });
});
