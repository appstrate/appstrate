// SPDX-License-Identifier: Apache-2.0

/**
 * E2E smoke tests for OAuth Model Providers — API surface.
 *
 * Covers the public endpoints exposed by `apps/api/src/routes/model-providers-oauth.ts`:
 *
 *   - `POST /api/model-providers-oauth/initiate` returns a real
 *     authorization URL with PKCE params for both supported providers.
 *   - The same endpoint rejects unknown / non-OAuth packageIds.
 *   - The callback enforces presence of `code`/`state` and surfaces
 *     OAuth-side errors via the `oauthError` redirect param.
 *   - The internal `/internal/oauth-token/:id` endpoint is not reachable
 *     without the run token (sanity check on auth gating).
 *   - Listing model provider keys returns the OAuth-extended shape
 *     (`authMode`, `needsReconnection`).
 *
 * These hit a freshly registered org via the API fixture — no real
 * network call leaves the platform (the OAuth `redirect_uri` is built
 * but never followed).
 *
 * @tags @smoke
 */

import { test, expect } from "../../fixtures/api.fixture.ts";

const CODEX = "@appstrate/provider-codex";
const CLAUDE = "@appstrate/provider-claude-code";

test.describe("OAuth Model Providers — API smoke", () => {
  test("initiate returns an authorization URL with PKCE params for Codex @smoke", async ({
    apiClient,
  }) => {
    const res = await apiClient.post("/model-providers-oauth/initiate", {
      providerPackageId: CODEX,
      label: "Smoke Test Codex",
    });
    expect(res.status()).toBe(200);

    const body = (await res.json()) as { authorizationUrl: string; state: string };
    expect(body.state).toMatch(/.+/);
    const url = new URL(body.authorizationUrl);

    expect(url.origin).toBe("https://auth.openai.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(url.searchParams.get("state")).toBe(body.state);
    // Scope set must include the registry-declared OAuth scopes
    const scope = url.searchParams.get("scope") ?? "";
    expect(scope).toContain("openid");
    expect(scope).toContain("profile");
    expect(scope).toContain("email");
  });

  test("initiate returns an authorization URL with PKCE params for Claude Code @smoke", async ({
    apiClient,
  }) => {
    const res = await apiClient.post("/model-providers-oauth/initiate", {
      providerPackageId: CLAUDE,
      label: "Smoke Test Claude",
    });
    expect(res.status()).toBe(200);

    const body = (await res.json()) as { authorizationUrl: string; state: string };
    const url = new URL(body.authorizationUrl);

    expect(url.origin).toBe("https://claude.ai");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const scope = url.searchParams.get("scope") ?? "";
    expect(scope).toContain("user:inference");
    expect(scope).toContain("user:profile");
    expect(scope).toContain("org:create_api_key");
  });

  test("initiate rejects an unknown providerPackageId", async ({ apiClient }) => {
    const res = await apiClient.post("/model-providers-oauth/initiate", {
      providerPackageId: "@example/not-a-real-provider",
      label: "Should fail",
    });
    expect(res.status()).toBe(400);
  });

  test("initiate rejects an empty label", async ({ apiClient }) => {
    const res = await apiClient.post("/model-providers-oauth/initiate", {
      providerPackageId: CODEX,
      label: "",
    });
    expect(res.status()).toBe(400);
  });

  test("callback with provider-side error redirects to settings with oauthError", async ({
    request,
    orgContext,
  }) => {
    // We don't follow redirects so we can read the Location header directly.
    const res = await request.get(
      "/api/model-providers-oauth/callback?error=access_denied&error_description=user%20cancelled",
      {
        headers: {
          Cookie: orgContext.auth.cookie,
        },
        maxRedirects: 0,
      },
    );
    expect(res.status()).toBe(302);
    const location = res.headers()["location"] ?? "";
    expect(location).toContain("/org-settings/models");
    // URLSearchParams.set uses application/x-www-form-urlencoded ("+" for spaces).
    expect(location).toMatch(/oauthError=user(\+|%20)cancelled/);
  });

  test("callback rejects requests missing code or state", async ({ request, orgContext }) => {
    const res = await request.get("/api/model-providers-oauth/callback", {
      headers: { Cookie: orgContext.auth.cookie },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(400);
  });

  test("internal OAuth token endpoint requires a run token (no anonymous read)", async ({
    request,
  }) => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await request.get(`/api/internal/oauth-token/${fakeId}`, {
      maxRedirects: 0,
    });
    // Auth is enforced by the internal middleware — must be 401, NOT 404
    // (404 would mean the auth check is bypassable, leaking platform state).
    expect([401, 403]).toContain(res.status());
  });

  test("listing model provider keys returns OAuth-extended shape", async ({ apiClient }) => {
    const res = await apiClient.get("/model-provider-keys");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const rows = body.data ?? [];
    expect(Array.isArray(rows)).toBe(true);
    // Smoke: every row carries an `authMode` field (extended in Phase 6.2).
    // Even an empty list passes — but if there's at least one (system-provided),
    // it must have the field.
    for (const row of rows) {
      expect(row).toHaveProperty("authMode");
    }
  });
});
