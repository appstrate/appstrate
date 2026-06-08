// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end coverage for the inbound MCP server (`/api/mcp/o/:org`) against a
 * REAL booted server (Playwright `api` project) — exercising the parts that
 * only exist at full boot and cannot be reached by the in-process `bun:test`
 * harness:
 *
 *  - Module permissions (`mcp:read`/`mcp:invoke`) aggregated into the AS scope
 *    vocabulary + role grants (boot wires `setModulePermissionsProvider`
 *    BEFORE `getAuth()` builds — the in-process harness does not).
 *  - The full Streamable-HTTP round-trip over real HTTP + real Redis
 *    (rate-limit) + real Postgres (audit).
 *  - The two onboarding paths end-to-end: an API key, and a self-service
 *    OAuth client (RFC 7591 DCR) running the PKCE + consent dance and minting
 *    a token audience-bound to ONE org's MCP resource (`…/api/mcp/o/<orgId>`)
 *    that the server accepts — and that is confined to that org's endpoint
 *    (rejected on every other route).
 *
 * The MCP server is exposed PER ORGANIZATION: a client targets
 * `…/api/mcp/o/<orgId>` and obtains a token whose RFC 8707 `aud` is that exact
 * URI, so it can only ever drive that one org. There is no `X-Org-Id` header —
 * the org is in the URL (API-key callers) / the token audience (Bearer).
 *
 * Two facts make this an `api`-project test (no browser): the MCP transport is
 * plain JSON-RPC over POST, and the OAuth flow's only HTML step (the consent
 * page) is driven by parsing its CSRF token out of the markup, exactly as the
 * in-process `oauth-flows` suite does.
 */

import { test, expect } from "../../fixtures/api.fixture.ts";
import { createApiKey } from "../../helpers/seed.ts";
import type { APIRequestContext } from "@playwright/test";

const BASE = "http://localhost:3000";
const MCP_ACCEPT = "application/json, text/event-stream";

/** The per-org MCP endpoint + its canonical RFC 8707 resource URI (identical). */
function mcpUrlForOrg(orgId: string): string {
  return `${BASE}/api/mcp/o/${orgId}`;
}

interface JsonRpcEnvelope {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** POST a JSON-RPC message to a per-org MCP endpoint with the given auth headers. */
async function mcpRpc(
  request: APIRequestContext,
  url: string,
  headers: Record<string, string>,
  message: Record<string, unknown>,
): Promise<{ status: number; envelope: JsonRpcEnvelope }> {
  const res = await request.post(url, {
    headers: { ...headers, "Content-Type": "application/json", Accept: MCP_ACCEPT },
    data: message,
  });
  const text = await res.text();
  return { status: res.status(), envelope: text ? (JSON.parse(text) as JsonRpcEnvelope) : {} };
}

/** Parse the JSON a tool returns in its first text content block. */
function toolPayload(envelope: JsonRpcEnvelope): {
  isError: boolean;
  data: Record<string, unknown>;
} {
  const content = (envelope.result?.content as Array<{ type: string; text: string }>) ?? [];
  const first = content[0];
  return {
    isError: Boolean(envelope.result?.isError),
    data: first ? (JSON.parse(first.text) as Record<string, unknown>) : {},
  };
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0" },
  },
};

// ─── PKCE helpers (mirror oauth-flows.test.ts) ──────────────────────────────

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return base64url(new Uint8Array(digest));
}
function randomVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

// ════════════════════════════════════════════════════════════════════════════
// Path A — API key (no browser)
// ════════════════════════════════════════════════════════════════════════════

test.describe("MCP over an API key (full stack)", () => {
  test("completes initialize → tools/list → search → invoke round-trip", async ({
    request,
    apiClient,
    orgContext,
  }) => {
    // A no-scope key inherits the creator's role scopes; the owner role grants
    // mcp:read + mcp:invoke (module RBAC, aggregated at boot). The key is bound
    // to the org, so the URL must name that same org (the router's url-vs-org
    // guard) — no X-Org-Id header.
    const { key } = await createApiKey(apiClient, "mcp-e2e");
    const url = mcpUrlForOrg(orgContext.org.orgId);
    const headers = { Authorization: `Bearer ${key}` };

    const init = await mcpRpc(request, url, headers, INIT);
    expect(init.status).toBe(200);
    expect(init.envelope.result?.serverInfo).toBeTruthy();

    const list = await mcpRpc(request, url, headers, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const names = ((list.envelope.result?.tools as Array<{ name: string }>) ?? [])
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(["describe_operation", "invoke_operation", "search_operations"]);

    const search = await mcpRpc(request, url, headers, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_operations", arguments: { query: "application", limit: 5 } },
    });
    const searchPayload = toolPayload(search.envelope);
    expect(searchPayload.isError).toBe(false);
    expect((searchPayload.data.count as number) ?? 0).toBeGreaterThan(0);

    // invoke a stable, side-effect-free GET (lists the org's applications).
    const invoke = await mcpRpc(request, url, headers, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "invoke_operation", arguments: { operation_id: "listApplications" } },
    });
    const payload = toolPayload(invoke.envelope);
    expect(payload.isError).toBe(false);
    expect(payload.data.status).toBe(200);
  });

  test("rejects GET on the per-org endpoint with 405 (POST-only transport)", async ({
    request,
    apiClient,
    orgContext,
  }) => {
    const { key } = await createApiKey(apiClient, "mcp-e2e-405");
    const res = await request.get(mcpUrlForOrg(orgContext.org.orgId), {
      headers: { Authorization: `Bearer ${key}`, Accept: MCP_ACCEPT },
    });
    expect(res.status()).toBe(405);
    expect(res.headers()["allow"]).toContain("POST");
  });

  test("rejects an unauthenticated call with 401 + RFC 9728 challenge", async ({
    request,
    orgContext,
  }) => {
    const res = await request.post(mcpUrlForOrg(orgContext.org.orgId), {
      headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT },
      data: INIT,
    });
    expect(res.status()).toBe(401);
    const challenge = res.headers()["www-authenticate"] ?? "";
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain("resource_metadata=");
    expect(challenge).toContain('scope="mcp:read mcp:invoke"');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Path B — self-service OAuth (RFC 7591 DCR → PKCE → audience-bound token)
// ════════════════════════════════════════════════════════════════════════════

test.describe("MCP over a self-service OAuth client (DCR + PKCE)", () => {
  const REDIRECT = "http://localhost:9931/callback";

  /** Register a public self-service client via RFC 7591 DCR. */
  async function registerDcrClient(request: APIRequestContext): Promise<string> {
    const res = await request.post(`${BASE}/api/auth/oauth2/register`, {
      headers: { "Content-Type": "application/json" },
      data: {
        client_name: "Claude Code (e2e)",
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "openid profile email offline_access",
      },
    });
    expect([200, 201]).toContain(res.status());
    const body = (await res.json()) as { client_id: string };
    expect(body.client_id).toBeTruthy();
    return body.client_id;
  }

  /** Drive authorize → consent → code for a logged-in platform user. */
  async function authorizeToCode(
    request: APIRequestContext,
    cookie: string,
    clientId: string,
  ): Promise<{ code: string; verifier: string }> {
    const verifier = randomVerifier();
    const challenge = await sha256Base64Url(verifier);
    const authorizeUrl =
      `${BASE}/api/auth/oauth2/authorize?` +
      new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        scope: "openid profile email offline_access",
        state: base64url(crypto.getRandomValues(new Uint8Array(16))),
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();

    const authorizeRes = await request.get(authorizeUrl, {
      headers: { cookie, accept: "text/html" },
      maxRedirects: 0,
    });
    expect(authorizeRes.status()).toBe(302);
    const consentUrl = new URL(authorizeRes.headers()["location"]!, BASE);

    const consentPage = await request.get(`${BASE}${consentUrl.pathname}${consentUrl.search}`, {
      headers: { cookie, accept: "text/html" },
    });
    expect(consentPage.status()).toBe(200);
    const csrfCookie = (consentPage.headers()["set-cookie"] ?? "")
      .split("\n")
      .map((c) => c.trim())
      .find((c) => c.startsWith("oidc_csrf="))!
      .split(";")[0]!;
    const csrfToken = (await consentPage.text()).match(/name="_csrf" value="([^"]+)"/)![1]!;

    const consentRes = await request.post(`${BASE}${consentUrl.pathname}${consentUrl.search}`, {
      headers: {
        cookie: `${cookie}; ${csrfCookie}`,
        "Content-Type": "application/x-www-form-urlencoded",
        accept: "application/json",
        origin: BASE,
      },
      form: { _csrf: csrfToken, accept: "true" },
      maxRedirects: 0,
    });
    expect([200, 302]).toContain(consentRes.status());
    let code: string | null = null;
    const loc = consentRes.headers()["location"];
    if (loc) {
      code = new URL(loc, BASE).searchParams.get("code");
    } else {
      const json = (await consentRes.json()) as { redirect_uri?: string; url?: string };
      const redirect = json.redirect_uri ?? json.url;
      if (redirect) code = new URL(redirect, BASE).searchParams.get("code");
    }
    expect(code).toBeTruthy();
    return { code: code!, verifier };
  }

  async function exchange(
    request: APIRequestContext,
    clientId: string,
    code: string,
    verifier: string,
    resource: string,
  ) {
    const res = await request.post(`${BASE}/api/auth/oauth2/token`, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      form: {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource,
      },
    });
    return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
  }

  async function refresh(
    request: APIRequestContext,
    clientId: string,
    refreshToken: string,
    resource: string,
  ) {
    const res = await request.post(`${BASE}/api/auth/oauth2/token`, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      form: {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        resource,
      },
    });
    return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
  }

  test("self-service client cannot mint a token for the broad platform audience", async ({
    request,
  }) => {
    // The token-endpoint guard fires in a before-hook, ahead of code
    // validation — a bogus code is enough to assert the audience restriction.
    const clientId = await registerDcrClient(request);
    const res = await request.post(`${BASE}/api/auth/oauth2/token`, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      form: {
        grant_type: "authorization_code",
        code: "irrelevant",
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: "x".repeat(43),
        resource: BASE, // APP_URL — forbidden for a self-service client
      },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe("invalid_target");
  });

  test("mints a per-org MCP token, drives that org's endpoint, and is confined off it", async ({
    playwright,
    orgContext,
  }) => {
    // A generic MCP client is UNAUTHENTICATED to Appstrate (no session cookie).
    // The `orgContext` fixture logs a user into the shared request jar, so use a
    // clean context for every client-side call — DCR register, token exchange,
    // and the Bearer calls — and pass the user's cookie EXPLICITLY only for the
    // interactive authorize/consent leg. (An authenticated DCR register would
    // hit Better Auth's Origin/CSRF gate — not the path a real client takes.)
    const anon = await playwright.request.newContext();
    try {
      const mcpUrl = mcpUrlForOrg(orgContext.org.orgId);
      const clientId = await registerDcrClient(anon);
      const { code, verifier } = await authorizeToCode(anon, orgContext.auth.cookie, clientId);

      // Mint a token bound to THIS org's MCP resource (the per-org URI is the
      // only audience a self-service client may request for it).
      const minted = await exchange(anon, clientId, code, verifier, mcpUrl);
      expect(minted.status).toBe(200);
      const accessToken = minted.body.access_token as string;
      expect(typeof accessToken).toBe("string");

      // The token's audience IS the org binding — no X-Org-Id header.
      const headers = { Authorization: `Bearer ${accessToken}` };

      // Accepted at the org's endpoint (audience matches) and carries the user's
      // authority (owner → mcp:read), so initialize succeeds.
      const init = await mcpRpc(anon, mcpUrl, headers, INIT);
      expect(init.status).toBe(200);
      expect(init.envelope.result?.serverInfo).toBeTruthy();

      // ...and an invoke dispatches in-process as the user (owner → applications:read).
      const invoke = await mcpRpc(anon, mcpUrl, headers, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "invoke_operation", arguments: { operation_id: "listApplications" } },
      });
      const payload = toolPayload(invoke.envelope);
      expect(payload.isError).toBe(false);
      expect(payload.data.status).toBe(200);

      // Outbound confinement: the SAME token on a non-resource route is rejected.
      // The token cannot be lifted from the MCP surface to the rest of the API.
      const lifted = await anon.get(`${BASE}/api/applications`, {
        headers: { ...headers, "X-Application-Id": orgContext.org.defaultAppId },
      });
      expect(lifted.status()).toBe(401);
    } finally {
      await anon.dispose();
    }
  });

  test("a refreshed token stays audience-bound and confined", async ({
    playwright,
    orgContext,
  }) => {
    // RFC 8707 resources persist on the refresh-token row (Better Auth 1.7) and
    // the token-endpoint guard runs on the refresh_token grant too, so a
    // refreshed access token must keep the SAME confinement: usable at the org's
    // endpoint, rejected everywhere else. Without this, a client could launder a
    // confined token into an unconfined one across a refresh.
    const anon = await playwright.request.newContext();
    try {
      const mcpUrl = mcpUrlForOrg(orgContext.org.orgId);
      const clientId = await registerDcrClient(anon);
      const { code, verifier } = await authorizeToCode(anon, orgContext.auth.cookie, clientId);
      const minted = await exchange(anon, clientId, code, verifier, mcpUrl);
      expect(minted.status).toBe(200);
      const refreshToken = minted.body.refresh_token as string;
      expect(typeof refreshToken).toBe("string"); // offline_access was requested

      const refreshed = await refresh(anon, clientId, refreshToken, mcpUrl);
      expect(refreshed.status).toBe(200);
      const newToken = refreshed.body.access_token as string;
      expect(typeof newToken).toBe("string");
      expect(newToken).not.toBe(minted.body.access_token);

      const headers = { Authorization: `Bearer ${newToken}` };

      // Refreshed token still drives the org's endpoint.
      const init = await mcpRpc(anon, mcpUrl, headers, INIT);
      expect(init.status).toBe(200);
      expect(init.envelope.result?.serverInfo).toBeTruthy();

      // ...and is still confined off the MCP surface.
      const lifted = await anon.get(`${BASE}/api/applications`, {
        headers: { ...headers, "X-Application-Id": orgContext.org.defaultAppId },
      });
      expect(lifted.status()).toBe(401);
    } finally {
      await anon.dispose();
    }
  });
});
