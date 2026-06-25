// SPDX-License-Identifier: Apache-2.0

/**
 * Integration coverage for the sidecar's `/llm/*` `oauth` path — the no-forge
 * runner mode for a driver that signs its OWN provider fingerprint (the official
 * Claude Agent SDK binary).
 *
 * The defining property under test: the sidecar does NOT forge. There are no
 * identity headers, no `system`-prepend, no `forceStream`. It only swaps the
 * bearer for a fresh real token, ensures the OAuth beta is present, and forwards
 * the driver's own fingerprint untouched. Mocks the platform token endpoint and
 * the upstream provider via one `fetchFn` dispatcher.
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
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k] = v;
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
  it("swaps the bearer, merges the oauth beta, and preserves the driver fingerprint", async () => {
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
        "anthropic-beta": "claude-code-20250219",
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

    // Driver fingerprint preserved verbatim — NOT forged by us.
    expect(up.headers["user-agent"]).toBe("claude-cli/1.2.3 (external, cli)");
    expect(up.headers["x-app"]).toBe("cli");

    // OAuth beta merged onto the driver's existing betas (both present, order kept).
    expect(up.headers["anthropic-beta"]).toBe("claude-code-20250219,oauth-2025-04-20");

    // Body forwarded UNCHANGED — no system-prepend injection.
    const body = JSON.parse(up.body!);
    expect(body.system).toBe("You are Claude Code.");
    expect(body.model).toBe("claude-haiku-4-5");
  });

  it("adds the oauth beta even when the driver sent none", async () => {
    const { fetchFn, calls } = setupFetchMock(upstreamOk);
    const deps = makeDeps(fetchFn);
    deps.config.llm = OAUTH_CFG;
    const app = createApp(deps);

    await app.request("/llm/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: "Bearer placeholder" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(calls[1]!.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
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
