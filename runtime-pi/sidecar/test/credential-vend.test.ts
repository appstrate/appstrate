// SPDX-License-Identifier: Apache-2.0

/**
 * Integration coverage for the sidecar's `GET /credential-vend` endpoint — the
 * in-container token-handover path for a `vend`-mode run (the Codex CLI, which
 * talks to the upstream directly and cannot be reverse-proxied through `/llm`).
 *
 * Invariants under test:
 *   - it vends `{ access_token, account_id }` resolved from the platform token
 *     endpoint ONLY for a `vend`-mode run,
 *   - it 403s for `oauth` / `api_key` / unconfigured runs (preserving their
 *     no-real-token-in-container invariant), and
 *   - it 410s when the credential needs reconnection.
 */

import { describe, it, expect, mock } from "bun:test";
import { createApp, type AppDeps } from "../app.ts";
import { OAuthTokenCache } from "../oauth-token-cache.ts";
import type { OAuthTokenResponse } from "@appstrate/core/sidecar-types";
import type { CredentialsResponse } from "../helpers.ts";

const PLATFORM_API = "http://platform-mock:3000";
const RUN_TOKEN = "run-tok";
// The in-container caller (Codex runner) always reaches the sidecar via an
// allowlisted host; `/credential-vend` enforces the same Host-header
// DNS-rebind guard as `/mcp` and `/runtime-events`.
const SIDECAR_HOST = { Host: "sidecar" };

function makeDeps(handler: (url: string) => Response): AppDeps {
  const fetchFn = mock(async (url: unknown) => {
    const u = typeof url === "string" ? url : (url as URL).toString();
    return handler(u);
  });
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

function tokenResponse(overrides: Partial<OAuthTokenResponse> = {}): Response {
  return new Response(
    JSON.stringify({
      accessToken: "oat-fresh-token",
      expiresAt: Date.now() + 60 * 60_000,
      accountId: "acct-123",
      ...overrides,
    } satisfies OAuthTokenResponse),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("GET /credential-vend", () => {
  it("vends the resolved token + account id for a vend-mode run", async () => {
    const deps = makeDeps(() => tokenResponse());
    deps.config.llm = { authMode: "vend", credentialId: "conn-codex" };
    const app = createApp(deps);

    const res = await app.request("/credential-vend", { headers: SIDECAR_HOST });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { access_token: string; account_id: string | null };
    expect(body).toEqual({ access_token: "oat-fresh-token", account_id: "acct-123" });
  });

  it("403s a request whose Host header is not allowlisted (DNS-rebind guard)", async () => {
    const deps = makeDeps(() => tokenResponse());
    deps.config.llm = { authMode: "vend", credentialId: "conn-codex" };
    const app = createApp(deps);

    const res = await app.request("/credential-vend", { headers: { Host: "evil.example.com" } });
    expect(res.status).toBe(403);
  });

  it("FREEZE-ON-FIRST: two GETs return the same token, getToken invoked once", async () => {
    // Counting fake that returns a DIFFERENT token on every call AND has no
    // internal TTL cache — so if the handler resolved twice, the second GET
    // would observe a fresh value. This isolates the endpoint-level freeze
    // from the OAuthTokenCache's own 30s TTL (which could otherwise mask a
    // regression).
    let getTokenCalls = 0;
    const countingCache = {
      getToken: async () => {
        getTokenCalls += 1;
        return {
          accessToken: `oat-token-${getTokenCalls}`,
          accountId: "acct-123",
          expiresAt: Date.now() + 60 * 60_000,
          fetchedAt: Date.now(),
        };
      },
      forceRefresh: async () => {
        throw new Error("forceRefresh must not be called by vend");
      },
      invalidate: () => {},
    };
    const deps = makeDeps(() => tokenResponse());
    deps.oauthTokenCache = countingCache as unknown as OAuthTokenCache;
    deps.config.llm = { authMode: "vend", credentialId: "conn-codex" };
    const app = createApp(deps);

    const res1 = await app.request("/credential-vend", { headers: SIDECAR_HOST });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { access_token: string; account_id: string | null };

    const res2 = await app.request("/credential-vend", { headers: SIDECAR_HOST });
    expect(res2.status).toBe(200);
    expect(res2.headers.get("cache-control")).toBe("no-store");
    const body2 = (await res2.json()) as { access_token: string; account_id: string | null };

    // Identical frozen snapshot returned both times — no post-freeze refresh.
    expect(body2).toEqual(body1);
    expect(body1.access_token).toBe("oat-token-1");
    // getToken hit EXACTLY once across both GETs (the freeze short-circuits #2).
    expect(getTokenCalls).toBe(1);
  });

  it("returns account_id null when the credential has none", async () => {
    const deps = makeDeps(() => tokenResponse({ accountId: undefined }));
    deps.config.llm = { authMode: "vend", credentialId: "conn-codex" };
    const app = createApp(deps);

    const res = await app.request("/credential-vend", { headers: SIDECAR_HOST });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account_id: string | null };
    expect(body.account_id).toBeNull();
  });

  it("403s for an oauth (Claude) run — no real token leaves the boundary", async () => {
    const deps = makeDeps(() => tokenResponse());
    deps.config.llm = {
      authMode: "oauth",
      baseUrl: "https://api.anthropic.com",
      credentialId: "c",
    };
    const app = createApp(deps);

    const res = await app.request("/credential-vend", { headers: SIDECAR_HOST });
    expect(res.status).toBe(403);
  });

  it("403s when no llm is configured", async () => {
    const deps = makeDeps(() => tokenResponse());
    const app = createApp(deps);

    const res = await app.request("/credential-vend", { headers: SIDECAR_HOST });
    expect(res.status).toBe(403);
  });

  it("410s when the credential needs reconnection", async () => {
    const deps = makeDeps((url) =>
      url.startsWith(PLATFORM_API)
        ? new Response(JSON.stringify({ detail: "reconnect" }), { status: 410 })
        : tokenResponse(),
    );
    deps.config.llm = { authMode: "vend", credentialId: "conn-codex" };
    const app = createApp(deps);

    const res = await app.request("/credential-vend", { headers: SIDECAR_HOST });
    expect(res.status).toBe(410);
  });
});
