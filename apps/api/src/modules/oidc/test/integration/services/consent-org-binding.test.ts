// SPDX-License-Identifier: Apache-2.0

/**
 * Consent-time org binding for self-service (DCR / CIMD) clients.
 *
 * A self-service instance client (e.g. an MCP client) has no org baked in. The
 * user picks one on the consent screen; the chosen org is stamped onto the
 * grant via Better Auth's `referenceId` seam (`postLogin.consentReferenceId`
 * reads the `AsyncLocalStorage` set by the consent POST handler) and surfaces
 * as the token's `org_id` claim — so the caller never needs `X-Org-Id`.
 *
 * This drives the full authorization-code + PKCE dance through the module's own
 * consent handler and asserts the minted token's claims:
 *  - org submitted → `org_id` claim == the chosen org, `actor_type: "user"`.
 *  - no org submitted → no `org_id` claim (back-compat: header path).
 *  - a foreign org submitted → 403 (membership is enforced before binding).
 *
 * Strategy-side pinning of that claim (no `X-Org-Id` needed, header-spoof
 * rejected) is covered end-to-end against a booted server in
 * `e2e/tests/mcp/mcp.api.spec.ts`.
 */

import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { decodeJwt } from "jose";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";
import { createTestContext, type TestContext } from "../../../../../../test/helpers/auth.ts";
import { overrideJwksResolver } from "../../../services/enduser-token.ts";
import { resetOidcGuardsLimiters } from "../../../auth/guards.ts";
import {
  registerProtectedResource,
  resetProtectedResources,
} from "../../../../../lib/protected-resources.ts";
import { getMcpResourceUri } from "../../../../mcp/resource.ts";
import oidcModule from "../../../index.ts";

const app = getTestApp({ modules: [oidcModule] });

const REDIRECT = "http://localhost:9971/callback";

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

/** Register a public self-service client (instance-level, via RFC 7591 DCR). */
async function registerSelfServiceClient(): Promise<string> {
  const res = await app.request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude Code (org-binding test)",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "openid profile email offline_access",
    }),
  });
  expect([200, 201]).toContain(res.status);
  return String(((await res.json()) as { client_id: string }).client_id);
}

interface ConsentResult {
  consentStatus: number;
  tokenStatus: number;
  payload: Record<string, unknown> | null;
  accessToken: string | null;
  refreshToken: string | null;
}

/**
 * Run authorize → consent → token for a logged-in user, optionally submitting
 * `org_id` on the consent form. Returns the consent status, token status, and
 * the decoded access-token payload (when a token was minted).
 */
async function driveConsent(
  clientId: string,
  cookie: string,
  submitOrgId?: string,
): Promise<ConsentResult> {
  const verifier = randomVerifier();
  const challenge = await sha256Base64Url(verifier);
  const authorizeUrl =
    `/api/auth/oauth2/authorize?` +
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: "openid profile email offline_access",
      state: base64url(crypto.getRandomValues(new Uint8Array(16))),
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

  const authorizeRes = await app.request(authorizeUrl, {
    headers: { cookie, accept: "text/html" },
    redirect: "manual",
  });
  expect(authorizeRes.status).toBe(302);
  const consentUrl = new URL(authorizeRes.headers.get("location")!, "http://localhost");
  expect(consentUrl.pathname).toBe("/api/oauth/consent");

  const consentPage = await app.request(consentUrl.pathname + consentUrl.search, {
    headers: { cookie, accept: "text/html" },
  });
  expect(consentPage.status).toBe(200);
  const csrfCookie = (consentPage.headers.get("set-cookie") ?? "")
    .split(",")
    .map((c) => c.trim())
    .find((c) => c.startsWith("oidc_csrf="))!
    .split(";")[0]!;
  const csrfToken = (await consentPage.text()).match(/name="_csrf" value="([^"]+)"/)![1]!;

  const form = new URLSearchParams({ _csrf: csrfToken, accept: "true" });
  if (submitOrgId !== undefined) form.set("org_id", submitOrgId);
  const consentRes = await app.request(consentUrl.pathname + consentUrl.search, {
    method: "POST",
    headers: {
      cookie: `${cookie}; ${csrfCookie}`,
      "Content-Type": "application/x-www-form-urlencoded",
      accept: "application/json",
      origin: "http://localhost:3000",
    },
    body: form.toString(),
    redirect: "manual",
  });
  if (consentRes.status >= 400) {
    return {
      consentStatus: consentRes.status,
      tokenStatus: 0,
      payload: null,
      accessToken: null,
      refreshToken: null,
    };
  }

  const loc = consentRes.headers.get("location");
  let code: string | null;
  if (loc) {
    code = new URL(loc, "http://localhost").searchParams.get("code");
  } else {
    const json = (await consentRes.json()) as { redirect_uri?: string; url?: string };
    code = new URL(json.redirect_uri ?? json.url ?? REDIRECT, "http://localhost").searchParams.get(
      "code",
    );
  }
  expect(code).toBeTruthy();

  const tokenRes = await app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      // Self-service clients may only request the MCP protected-resource
      // audience; required for the plugin to mint a JWT (vs. opaque) token.
      resource: getMcpResourceUri(),
    }).toString(),
  });
  if (tokenRes.status !== 200) {
    return {
      consentStatus: consentRes.status,
      tokenStatus: tokenRes.status,
      payload: null,
      accessToken: null,
      refreshToken: null,
    };
  }
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token?: string };
  return {
    consentStatus: consentRes.status,
    tokenStatus: tokenRes.status,
    payload: decodeJwt(tokens.access_token) as Record<string, unknown>,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
  };
}

/** Exchange a refresh token for a fresh pair, bound to the MCP resource. */
async function refreshMcpToken(clientId: string, refreshToken: string) {
  const res = await app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      resource: getMcpResourceUri(),
    }).toString(),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

describe("consent-time org binding (self-service clients)", () => {
  let ctx: TestContext;

  beforeAll(() => {
    overrideJwksResolver(null);
  });

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    overrideJwksResolver(null);
    resetOidcGuardsLimiters();
    resetProtectedResources();
    registerProtectedResource("/api/mcp", getMcpResourceUri);
    ctx = await createTestContext({ orgSlug: "orgbind" });
  });

  it("binds the chosen org onto the token as the org_id claim", async () => {
    const clientId = await registerSelfServiceClient();
    const { tokenStatus, payload } = await driveConsent(clientId, ctx.cookie, ctx.orgId);
    expect(tokenStatus).toBe(200);
    expect(payload?.actor_type).toBe("user");
    expect(payload?.org_id).toBe(ctx.orgId);
  });

  it("omits org_id when none is chosen (header-path back-compat)", async () => {
    const clientId = await registerSelfServiceClient();
    const { tokenStatus, payload } = await driveConsent(clientId, ctx.cookie, undefined);
    expect(tokenStatus).toBe(200);
    expect(payload?.actor_type).toBe("user");
    expect(payload?.org_id).toBeUndefined();
  });

  it("rejects binding an org the user is not a member of", async () => {
    const clientId = await registerSelfServiceClient();
    const foreignOrgId = crypto.randomUUID();
    const { consentStatus, tokenStatus } = await driveConsent(clientId, ctx.cookie, foreignOrgId);
    expect(consentStatus).toBe(403);
    expect(tokenStatus).toBe(0);
  });

  it("pins the bound org so an org-scoped route resolves WITHOUT X-Org-Id", async () => {
    const clientId = await registerSelfServiceClient();
    const { accessToken } = await driveConsent(clientId, ctx.cookie, ctx.orgId);
    expect(accessToken).toBeTruthy();

    // Drop the protected-resource registration so the audience guard is a
    // no-op here — this test isolates *org pinning* from audience confinement
    // (which is covered separately). The token's `org_id` claim alone must
    // resolve org context.
    resetProtectedResources();

    const noHeader = await app.request("/api/applications", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(noHeader.status).toBe(200);

    // A conflicting X-Org-Id is rejected — the token's org is authoritative,
    // it cannot be spoofed to another org the user happens to belong to.
    const spoofed = await app.request("/api/applications", {
      headers: { Authorization: `Bearer ${accessToken}`, "X-Org-Id": crypto.randomUUID() },
    });
    expect(spoofed.status).toBe(403);
  });
});

describe("MCP OAuth refresh hygiene (RFC 9700 §4.14)", () => {
  // The MCP path uses Better Auth's `/oauth2/token`, which natively rotates
  // refresh tokens and detects reuse: presenting an already-rotated token tears
  // down the whole family. This locks in the guarantee the MCP onboarding
  // depends on (no need to reimplement reuse detection for `oauth_refresh_tokens`).
  let ctx: TestContext;

  beforeAll(() => {
    overrideJwksResolver(null);
  });

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    overrideJwksResolver(null);
    resetOidcGuardsLimiters();
    resetProtectedResources();
    registerProtectedResource("/api/mcp", getMcpResourceUri);
    ctx = await createTestContext({ orgSlug: "mcprefresh" });
  });

  it("rotates the refresh token and revokes the family on reuse", async () => {
    const clientId = await registerSelfServiceClient();
    const { refreshToken } = await driveConsent(clientId, ctx.cookie, ctx.orgId);
    expect(refreshToken).toBeTruthy();

    // First rotation succeeds and returns a new refresh token.
    const rotated = await refreshMcpToken(clientId, refreshToken!);
    expect(rotated.status).toBe(200);
    const next = rotated.body.refresh_token as string;
    expect(typeof next).toBe("string");
    expect(next).not.toBe(refreshToken);

    // Reusing the ALREADY-ROTATED token is rejected...
    const reuse = await refreshMcpToken(clientId, refreshToken!);
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe("invalid_grant");

    // ...and the reuse tore down the whole family, so the legitimately-rotated
    // token is now dead too.
    const afterReuse = await refreshMcpToken(clientId, next);
    expect(afterReuse.status).toBe(400);
    expect(afterReuse.body.error).toBe("invalid_grant");
  });
});
