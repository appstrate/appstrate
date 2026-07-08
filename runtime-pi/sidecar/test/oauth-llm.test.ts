// SPDX-License-Identifier: Apache-2.0

/**
 * Integration coverage for the sidecar's `/llm/*` `oauth` path — the no-forge
 * mode for an OAuth subscription. The Pi SDK (in-container) already signs the
 * subscription request shape (Anthropic OAuth fingerprint or codex-responses
 * headers).
 *
 * The defining property under test: the sidecar does NOT forge. It only swaps
 * the placeholder bearer for a fresh real token and drops any x-api-key
 * (bearer-only), forwarding every other header the SDK sent — including the
 * anthropic-beta the SDK emitted — untouched. Mocks the platform token endpoint
 * and the upstream provider via one `fetchFn` dispatcher.
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

function buildOAuthTokenResponse(overrides: Partial<OAuthTokenResponse> = {}): OAuthTokenResponse {
  return {
    accessToken: "oat-fresh-token",
    expiresAt: Date.now() + 60 * 60_000,
    ...overrides,
  };
}

function setupFetchMock(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: FetchCall[] = [];
  const fetchFn = mock(async (url: unknown, init?: RequestInit) => {
    const u = typeof url === "string" ? url : (url as URL).toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      // The oauth path forwards a `Headers` instance; the non-oauth path a
      // plain object. Normalize both (Headers/[k,v][] are iterable, plain
      // objects via Object.entries) so captured headers are never empty.
      const h = init.headers;
      const entries: Iterable<[string, string]> =
        h instanceof Headers || Symbol.iterator in Object(h)
          ? (h as Headers)
          : Object.entries(h as Record<string, string>);
      for (const [k, v] of entries) headers[k.toLowerCase()] = v;
    }
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url: u, method: init?.method ?? "GET", headers, body });
    return handler(u, init ?? {});
  });
  return { fetchFn, calls };
}

function makeDeps(fetchFn: ReturnType<typeof mock>): AppDeps {
  const cache = new OAuthTokenCache({
    getPlatformApiUrl: () => PLATFORM_API,
    getRunToken: () => RUN_TOKEN,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return {
    config: { platformApiUrl: PLATFORM_API, runToken: RUN_TOKEN },
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
    fetchFn: fetchFn as unknown as typeof fetch,
    isReady: () => true,
    oauthTokenCache: cache,
  };
}

const OAUTH_CFG: LlmProxyOauthConfig = {
  authMode: "oauth",
  baseUrl: "https://api.anthropic.com",
  credentialId: "conn-oauth",
};

function upstreamOk(url: string): Response {
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
}

describe("/llm/* oauth — no forging", () => {
  it("swaps the bearer and preserves the SDK fingerprint verbatim (incl. anthropic-beta)", async () => {
    const { fetchFn, calls } = setupFetchMock(upstreamOk);
    const deps = makeDeps(fetchFn);
    deps.config.llm = OAUTH_CFG;
    const app = createApp(deps);

    const res = await app.request("/llm/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer placeholder",
        "user-agent": "claude-cli/1.2.3 (external, cli)",
        "x-app": "cli",
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        system: "You are Claude Code.",
        messages: [],
      }),
    });
    expect(res.status).toBe(200);

    // call 0 → platform token; call 1 → upstream provider.
    expect(calls).toHaveLength(2);
    const up = calls[1]!;
    expect(up.url).toBe("https://api.anthropic.com/v1/messages");

    // Real bearer swapped in (placeholder gone).
    expect(up.headers["authorization"]).toBe("Bearer oat-fresh-token");

    // SDK fingerprint preserved verbatim — NOT forged/altered by us. The Pi SDK
    // emits user-agent, x-app AND anthropic-beta; the sidecar forwards them as-is.
    expect(up.headers["user-agent"]).toBe("claude-cli/1.2.3 (external, cli)");
    expect(up.headers["x-app"]).toBe("cli");
    expect(up.headers["anthropic-beta"]).toBe("claude-code-20250219,oauth-2025-04-20");

    // Body forwarded UNCHANGED — no system-prepend injection.
    const body = JSON.parse(up.body!);
    expect(body.system).toBe("You are Claude Code.");
    expect(body.model).toBe("claude-haiku-4-5");
  });

  it("does not add or alter anthropic-beta (the SDK owns the fingerprint)", async () => {
    const { fetchFn, calls } = setupFetchMock(upstreamOk);
    const deps = makeDeps(fetchFn);
    deps.config.llm = OAUTH_CFG;
    const app = createApp(deps);

    await app.request("/llm/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: "Bearer placeholder" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    // The sidecar injects no beta of its own — none was sent, none is added.
    expect(calls[1]!.headers["anthropic-beta"]).toBeUndefined();
  });

  it("strips any x-api-key (this path is bearer-only)", async () => {
    const { fetchFn, calls } = setupFetchMock(upstreamOk);
    const deps = makeDeps(fetchFn);
    deps.config.llm = OAUTH_CFG;
    const app = createApp(deps);

    await app.request("/llm/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "sk-ant-leak" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    const up = calls[1]!;
    const keys = Object.keys(up.headers).map((k) => k.toLowerCase());
    expect(keys).not.toContain("x-api-key");
  });

  it("rewrites the model alias→real in the request body when modelSwap is set", async () => {
    const { fetchFn, calls } = setupFetchMock(upstreamOk);
    const deps = makeDeps(fetchFn);
    deps.config.llm = {
      ...OAUTH_CFG,
      modelSwap: { alias: "appstrate-small", real: "claude-haiku-4-5" },
    };
    const app = createApp(deps);

    await app.request("/llm/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "appstrate-small", messages: [] }),
    });
    expect(JSON.parse(calls[1]!.body!).model).toBe("claude-haiku-4-5");
  });

  it("retries once on 401 with a force-refreshed token", async () => {
    let upstreamN = 0;
    const { fetchFn, calls } = setupFetchMock((url) => {
      if (url.startsWith(PLATFORM_API)) {
        const isRefresh = url.endsWith("/refresh");
        return new Response(
          JSON.stringify(
            buildOAuthTokenResponse({ accessToken: isRefresh ? "oat-refreshed" : "oat-stale" }),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      upstreamN += 1;
      return new Response(upstreamN === 1 ? "unauth" : '{"id":"ok"}', {
        status: upstreamN === 1 ? 401 : 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const deps = makeDeps(fetchFn);
    deps.config.llm = OAUTH_CFG;
    const app = createApp(deps);

    const res = await app.request("/llm/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(res.status).toBe(200);
    const upstreamCalls = calls.filter((c) => c.url.startsWith("https://api.anthropic.com"));
    expect(upstreamCalls).toHaveLength(2);
    expect(upstreamCalls[1]!.headers["authorization"]).toBe("Bearer oat-refreshed");
  });
});
