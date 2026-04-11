// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end Authorization Code + PKCE flow against the live Better Auth
 * oauth-provider plugin wired by the OIDC module.
 *
 * Covers:
 *  - Discovery: GET /.well-known/openid-configuration proxied from Better
 *    Auth's canonical endpoint, reachable via the module's public alias.
 *  - Client registration via `/api/oauth/clients` admin CRUD returns a
 *    plaintext secret exactly once.
 *  - Full `/oauth2/authorize` → module consent POST → `/oauth2/token` PKCE
 *    flow. The flow drives the module's custom consent handler (which
 *    forwards the signed `oauth_query` to Better Auth's `/oauth2/consent`
 *    endpoint) so we catch the exact production path — not a direct call
 *    to Better Auth that would bypass our wiring.
 *  - The minted access token verifies against the module's
 *    `verifyEndUserAccessToken` — proving the JWT is ES256-signed by the
 *    `jwks` table + carries the `endUserId` + `applicationId` custom
 *    claims injected by `customAccessTokenClaims`.
 *  - PKCE enforcement: a tampered `code_verifier` fails exchange.
 *
 * What this test intentionally does NOT assert:
 *  - Refresh token grant (`grant_type=refresh_token`). Covered by the
 *    upstream `@better-auth/oauth-provider` test suite and guaranteed by
 *    `offline_access` being in the module's scope vocabulary.
 *  - Full `/userinfo` contents. That endpoint is served by Better Auth
 *    and covered by the upstream package's own test suite.
 *  - Browser consent screen rendering. Covered in
 *    `routes/oauth-enduser-pages.test.ts`.
 */

import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import oidcModule from "../../../index.ts";
import { overrideJwksResolver } from "../../../services/enduser-token.ts";
import { resetOidcGuardsLimiters } from "../../../auth/guards.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";
import { decodeJwt } from "jose";

const app = getTestApp({ modules: [oidcModule] });

/** Base64url-encode a byte array without padding. */
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64url(new Uint8Array(digest));
}

function randomVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Extract the authorization code from a consent-endpoint response. The
 * plugin's response shape depends on its version — 302 with a `Location`
 * header, or 200 with a JSON body containing the redirect URL under one
 * of `redirect_uri` / `redirectURI` / `url`.
 */
async function extractCodeFromConsentResponse(res: Response): Promise<string | null> {
  const loc = res.headers.get("location");
  if (loc) {
    return new URL(loc, "http://localhost").searchParams.get("code");
  }
  const json = (await res.json()) as {
    redirect_uri?: string;
    redirectURI?: string;
    url?: string;
  };
  const redirectUri = json.redirect_uri ?? json.redirectURI ?? json.url;
  if (!redirectUri) return null;
  return new URL(redirectUri).searchParams.get("code");
}

async function registerClient(
  ctx: TestContext,
): Promise<{ clientId: string; clientSecret: string }> {
  const res = await app.request("/api/oauth/clients", {
    method: "POST",
    headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "E2E Satellite",
      redirectUris: ["https://satellite.example.com/callback"],
      scopes: ["openid", "profile", "email", "offline_access", "connections:read", "runs:read"],
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { clientId: string; clientSecret: string };
}

/**
 * Mint a Better Auth session cookie for a signed-up user so the
 * `/oauth2/authorize` → `/oauth2/consent` pair skips the login redirect.
 * Mirrors the pattern `apps/api/test/helpers/auth.ts` uses.
 */
async function signUpEndUser(
  email = "alice@satellite.example.com",
  password = "Sup3rSecretPass!",
): Promise<{ cookie: string; userId: string }> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "Alice" }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error(`no session cookie: ${setCookie}`);
  const cookie = `better-auth.session_token=${match[1]}`;
  const body = (await res.json()) as { user: { id: string } };
  return { cookie, userId: body.user.id };
}

describe("OAuth 2.1 Authorization Code + PKCE end-to-end", () => {
  let ctx: TestContext;
  let clientId: string;
  let clientSecret: string;

  beforeAll(() => {
    // Make sure the JWKS cache starts clean so verifyEndUserAccessToken
    // fetches the ES256 keys the jwt plugin just installed.
    overrideJwksResolver(null);
  });

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    overrideJwksResolver(null);
    resetOidcGuardsLimiters();
    ctx = await createTestContext({ orgSlug: "e2eoauth" });
    const client = await registerClient(ctx);
    clientId = client.clientId;
    clientSecret = client.clientSecret;
  });

  it("serves full OIDC discovery metadata via the module proxy", async () => {
    // The `@better-auth/oauth-provider` plugin declares its discovery
    // endpoint with `metadata: { SERVER_ONLY: true }`, so Better Auth never
    // exposes it over HTTP — the only way to reach the payload is the
    // module's proxy, which calls `auth.api.getOpenIdConfig()`
    // programmatically. We hit the module-scoped alias here; it is the
    // canonical path satellites should auto-configure against.
    const res = await app.request("/api/.well-known/openid-configuration");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issuer: string;
      token_endpoint: string;
      authorization_endpoint: string;
      jwks_uri: string;
      scopes_supported?: string[];
      response_types_supported?: string[];
      code_challenge_methods_supported?: string[];
    };
    expect(body.issuer).toBeTruthy();
    expect(body.token_endpoint).toContain("/oauth2/token");
    expect(body.authorization_endpoint).toContain("/oauth2/authorize");
    expect(body.jwks_uri).toContain("/jwks");
    expect(body.scopes_supported).toContain("openid");
    expect(body.scopes_supported).toContain("offline_access");
    expect(body.response_types_supported).toContain("code");
    expect(body.code_challenge_methods_supported).toContain("S256");
  });

  it("mints an access token via the full PKCE flow through the module consent handler", async () => {
    const { cookie } = await signUpEndUser();

    const verifier = randomVerifier();
    const challenge = await sha256Base64Url(verifier);
    const state = base64url(crypto.getRandomValues(new Uint8Array(16)));

    // ── Step 1 ── GET /oauth2/authorize with the session cookie. Better
    // Auth persists the pending authorization state (in AsyncLocalStorage
    // per-request) and replies with a 302 to our custom consent page,
    // carrying the signed query string (`?...&exp=...&sig=...`) that the
    // consent POST will echo back as `oauth_query`.
    const authorizeUrl =
      `/api/auth/oauth2/authorize?` +
      new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://satellite.example.com/callback",
        scope: "openid profile email offline_access",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();

    const authorizeRes = await app.request(authorizeUrl, {
      method: "GET",
      headers: { cookie, accept: "text/html" },
      redirect: "manual",
    });
    expect(authorizeRes.status).toBe(302);
    const consentLocation = authorizeRes.headers.get("location");
    expect(consentLocation).toBeTruthy();
    const consentUrl = new URL(consentLocation!, "http://localhost");
    expect(consentUrl.pathname).toBe("/api/oauth/enduser/consent");
    // Better Auth has signed the query — both params must be present.
    expect(consentUrl.searchParams.get("sig")).toBeTruthy();
    expect(consentUrl.searchParams.get("exp")).toBeTruthy();

    // ── Step 2 ── GET the consent page to obtain the CSRF token + cookie.
    const consentPageRes = await app.request(consentUrl.pathname + consentUrl.search, {
      method: "GET",
      headers: { cookie, accept: "text/html" },
    });
    expect(consentPageRes.status).toBe(200);
    const csrfCookie = (consentPageRes.headers.get("set-cookie") ?? "")
      .split(",")
      .map((c) => c.trim())
      .find((c) => c.startsWith("oidc_csrf="));
    expect(csrfCookie).toBeTruthy();
    const csrfCookieValue = csrfCookie!.split(";")[0]!;
    const consentHtml = await consentPageRes.text();
    const csrfMatch = consentHtml.match(/name="_csrf" value="([^"]+)"/);
    expect(csrfMatch).not.toBeNull();
    const csrfToken = csrfMatch![1]!;

    // ── Step 3 ── POST /api/oauth/enduser/consent — our custom handler
    // verifies CSRF, then forwards `oauth_query` (the signed query from the
    // URL) to Better Auth's `/oauth2/consent`. This is the step that was
    // silently broken before the `oauth_query` fix — previously we passed
    // a non-existent `consent_code` parameter and Better Auth never found
    // the pending authorization state.
    const consentFormBody = new URLSearchParams({
      _csrf: csrfToken,
      accept: "true",
    });
    const consentRes = await app.request(consentUrl.pathname + consentUrl.search, {
      method: "POST",
      headers: {
        cookie: `${cookie}; ${csrfCookieValue}`,
        "Content-Type": "application/x-www-form-urlencoded",
        // Request JSON back from Better Auth so we can parse the
        // redirect_uri deterministically.
        accept: "application/json",
        origin: "http://localhost:3000",
      },
      body: consentFormBody.toString(),
      redirect: "manual",
    });
    expect([200, 302]).toContain(consentRes.status);

    const code = await extractCodeFromConsentResponse(consentRes);
    expect(code).toBeTruthy();

    // ── Step 4 ── Exchange code + PKCE verifier for tokens. Must succeed.
    // CRITICAL: `resource` is REQUIRED on the token request for the plugin
    // to issue a JWT access token (RFC 8707 resource indicator). Without
    // an audience, `createUserTokens → checkResource` returns undefined,
    // `isJwtAccessToken = audience && !disableJwtPlugin` falls to false,
    // and the plugin mints an opaque access token that our `Bearer ey...`
    // strategy cannot match. Satellites MUST pass this on /token — see
    // the module README satellite integration example.
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: "https://satellite.example.com/callback",
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: verifier,
      resource: "http://localhost:3000",
    });
    const tokenRes = await app.request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      id_token?: string;
      refresh_token?: string;
      token_type?: string;
      expires_in?: number;
    };
    expect(typeof tokens.access_token).toBe("string");
    // Offline access was requested — refresh token must be issued.
    expect(typeof tokens.refresh_token).toBe("string");

    // ── Step 5 ── Decode the access token (signature verification is
    // covered by `test/integration/middleware/enduser-token-auth.test.ts`
    // which spins up a local JWKS server). Here we assert the payload
    // shape — proving `customAccessTokenClaims` actually ran and injected
    // `endUserId` + `applicationId` + `orgId` via `resolveOrCreateEndUser`.
    const payload = decodeJwt(tokens.access_token) as {
      sub?: string;
      scope?: string;
      endUserId?: string;
      applicationId?: string;
      orgId?: string;
    };
    expect(payload.sub).toBeTruthy();
    expect(payload.scope).toContain("openid");
    expect(payload.scope).toContain("offline_access");
    expect(payload.endUserId).toMatch(/^eu_/);
    expect(payload.applicationId).toBeTruthy();
    expect(payload.orgId).toBeTruthy();
  });

  it("a real minted Bearer JWT authenticates against a core route via the OIDC strategy", async () => {
    // End-to-end regression for the issuer-mismatch bug that made the
    // module's headline promise ("Bearer JWT against core routes") silently
    // fail in production: the auth strategy called `jose.jwtVerify` with
    // `issuer: env.APP_URL`, but Better Auth mints `iss = ${APP_URL}/api/auth`.
    // The check threw, `verifyEndUserAccessToken` returned null, the strategy
    // fell through, and every Bearer call got 401.
    //
    // The happy-path test above decodes the JWT with `decodeJwt` (no
    // signature check), so it could not catch this. This test round-trips
    // a REAL minted token through the full core auth middleware.
    const { cookie } = await signUpEndUser("e2e-bearer@satellite.example.com", "Sup3rSecret!");
    const { code, verifier } = await runHappyPathToCode({ cookie });
    const tokens = await exchangeCodeForTokens(code, verifier);
    expect(tokens.access_token).toBeTruthy();

    // Hit a core, non-app-scoped route with the minted token. The OIDC
    // strategy must: verify the signature via the local JWKS, pass the
    // issuer check (`${APP_URL}/api/auth`), resolve the end-user from the
    // `endUserId` custom claim, and emit an AuthResolution — otherwise the
    // request falls through to core auth and returns 401.
    const res = await app.request("/api/profile", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(res.status).toBe(200);
  });

  it("PKCE enforcement rejects a tampered code_verifier at /oauth2/token", async () => {
    const { cookie } = await signUpEndUser("bob@satellite.example.com", "AnotherSecret123!");
    const verifier = randomVerifier();
    const challenge = await sha256Base64Url(verifier);
    const state = base64url(crypto.getRandomValues(new Uint8Array(16)));

    const authorizeUrl =
      `/api/auth/oauth2/authorize?` +
      new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://satellite.example.com/callback",
        scope: "openid",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();

    const authorizeRes = await app.request(authorizeUrl, {
      method: "GET",
      headers: { cookie, accept: "text/html" },
      redirect: "manual",
    });
    expect(authorizeRes.status).toBe(302);
    const consentUrl = new URL(authorizeRes.headers.get("location")!, "http://localhost");

    // GET consent page for CSRF token.
    const consentPageRes = await app.request(consentUrl.pathname + consentUrl.search, {
      headers: { cookie, accept: "text/html" },
    });
    const csrfCookie = (consentPageRes.headers.get("set-cookie") ?? "")
      .split(",")
      .map((c) => c.trim())
      .find((c) => c.startsWith("oidc_csrf="))!
      .split(";")[0]!;
    const csrfToken = (await consentPageRes.text()).match(/name="_csrf" value="([^"]+)"/)![1]!;

    // Accept consent via the module handler.
    const consentRes = await app.request(consentUrl.pathname + consentUrl.search, {
      method: "POST",
      headers: {
        cookie: `${cookie}; ${csrfCookie}`,
        "Content-Type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({ _csrf: csrfToken, accept: "true" }).toString(),
      redirect: "manual",
    });
    expect([200, 302]).toContain(consentRes.status);

    const code = await extractCodeFromConsentResponse(consentRes);
    expect(code).toBeTruthy();

    // Exchange with a DIFFERENT verifier than the one that hashed into the
    // challenge — must fail. `resource` is present (the guard enforces it),
    // so the rejection here is guaranteed to come from PKCE verification.
    const tokenRes = await app.request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: "https://satellite.example.com/callback",
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: randomVerifier(), // wrong verifier
        resource: "http://localhost:3000",
      }).toString(),
    });
    // Plugin returns 401 UNAUTHORIZED on PKCE verification failure.
    expect([400, 401]).toContain(tokenRes.status);
  });

  it("oauth-provider plugin is wired — /oauth2/authorize returns something other than 404", async () => {
    // Smallest sanity check the plugin is loaded — without session cookie,
    // Better Auth should redirect to the login page (302) or return 400
    // for a missing param. A 404 would mean the plugin was not registered.
    const res = await app.request("/api/auth/oauth2/authorize", {
      method: "GET",
      redirect: "manual",
    });
    expect(res.status).not.toBe(404);
  });

  /**
   * Drive a full authorize → consent → code exchange for an existing session,
   * returning the authorization code and the PKCE verifier. Used by the
   * refresh / revoke / introspect tests below.
   */
  async function runHappyPathToCode(opts: {
    cookie: string;
    email?: string;
  }): Promise<{ code: string; verifier: string }> {
    const verifier = randomVerifier();
    const challenge = await sha256Base64Url(verifier);
    const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
    const authorizeUrl =
      `/api/auth/oauth2/authorize?` +
      new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://satellite.example.com/callback",
        scope: "openid profile email offline_access",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
    const authorizeRes = await app.request(authorizeUrl, {
      headers: { cookie: opts.cookie, accept: "text/html" },
      redirect: "manual",
    });
    const consentUrl = new URL(authorizeRes.headers.get("location")!, "http://localhost");
    const consentPageRes = await app.request(consentUrl.pathname + consentUrl.search, {
      headers: { cookie: opts.cookie, accept: "text/html" },
    });
    const csrfCookie = (consentPageRes.headers.get("set-cookie") ?? "")
      .split(",")
      .map((c) => c.trim())
      .find((c) => c.startsWith("oidc_csrf="))!
      .split(";")[0]!;
    const csrfToken = (await consentPageRes.text()).match(/name="_csrf" value="([^"]+)"/)![1]!;
    const consentRes = await app.request(consentUrl.pathname + consentUrl.search, {
      method: "POST",
      headers: {
        cookie: `${opts.cookie}; ${csrfCookie}`,
        "Content-Type": "application/x-www-form-urlencoded",
        accept: "application/json",
        origin: "http://localhost:3000",
      },
      body: new URLSearchParams({ _csrf: csrfToken, accept: "true" }).toString(),
      redirect: "manual",
    });
    const code = await extractCodeFromConsentResponse(consentRes);
    return { code: code!, verifier };
  }

  async function exchangeCodeForTokens(
    code: string,
    verifier: string,
    extras: Record<string, string> = {},
  ): Promise<{
    access_token: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
  }> {
    const res = await app.request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://satellite.example.com/callback",
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
        resource: "http://localhost:3000",
        ...extras,
      }).toString(),
    });
    expect(res.status).toBe(200);
    return res.json() as never;
  }

  it("rejects /oauth2/token without resource parameter (RFC 8707 enforcement)", async () => {
    // Even with a valid code, PKCE verifier, and client credentials, the
    // guard rejects the call BEFORE oauth-provider runs — so this asserts
    // the pre-check is the one speaking, not a downstream PKCE / client
    // check. We deliberately use a bogus code to show the guard fires
    // first (it would otherwise be consumed by oauth-provider).
    const res = await app.request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "fake-code",
        redirect_uri: "https://satellite.example.com/callback",
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: "fake-verifier",
        // NO resource
      }).toString(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; error_description?: string };
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toContain("RFC 8707");
  });

  it("rejects /oauth2/token with a resource not in validAudiences", async () => {
    const res = await app.request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "fake-code",
        redirect_uri: "https://satellite.example.com/callback",
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: "fake-verifier",
        resource: "https://evil.example.com",
      }).toString(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_request");
  });

  it("rate-limits /oauth2/token to 30 req/min per IP", async () => {
    // The guard limiter is keyed on x-forwarded-for; app.request() sets no
    // such header, so all spam shares the `unknown` bucket. Fire 31 posts;
    // the 31st must be rejected with 429.
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: "fake",
      redirect_uri: "https://satellite.example.com/callback",
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: "fake",
      resource: "http://localhost:3000",
    }).toString();

    let rateLimited = 0;
    for (let i = 0; i < 35; i++) {
      const res = await app.request("/api/auth/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (res.status === 429) rateLimited++;
    }
    expect(rateLimited).toBeGreaterThan(0);
  });

  it("issues a fresh JWT access token via grant_type=refresh_token with custom claims re-injected", async () => {
    const { cookie } = await signUpEndUser("refresh@satellite.example.com", "Sup3rSecret!");
    const { code, verifier } = await runHappyPathToCode({ cookie });
    const tokens = await exchangeCodeForTokens(code, verifier);
    expect(tokens.refresh_token).toBeTruthy();
    const initialAccess = tokens.access_token;

    const refreshRes = await app.request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token!,
        client_id: clientId,
        client_secret: clientSecret,
        resource: "http://localhost:3000",
      }).toString(),
    });
    expect(refreshRes.status).toBe(200);
    const refreshed = (await refreshRes.json()) as { access_token: string };
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(initialAccess);

    // Prove customAccessTokenClaims re-ran on refresh — endUserId + applicationId
    // are injected only by that closure, so their presence on the new token
    // is the canary.
    const payload = decodeJwt(refreshed.access_token) as {
      endUserId?: string;
      applicationId?: string;
    };
    expect(payload.endUserId).toMatch(/^eu_/);
    expect(payload.applicationId).toBeTruthy();
  });

  it("refresh_token grant also requires resource parameter", async () => {
    const res = await app.request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "whatever",
        client_id: clientId,
        client_secret: clientSecret,
        // NO resource
      }).toString(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_request");
  });

  it("introspect returns {active:true} for a live token and {active:false} for garbage", async () => {
    const { cookie } = await signUpEndUser("intro@satellite.example.com", "Sup3rSecret!");
    const { code, verifier } = await runHappyPathToCode({ cookie });
    const tokens = await exchangeCodeForTokens(code, verifier);

    const liveRes = await app.request("/api/auth/oauth2/introspect", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: tokens.access_token,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    expect(liveRes.status).toBe(200);
    const liveBody = (await liveRes.json()) as { active?: boolean; sub?: string };
    expect(liveBody.active).toBe(true);

    // RFC 7662 §2.2: the authorization server "MAY respond with HTTP 200
    // and `active: false`" OR with a 4xx error for malformed/unknown tokens.
    // Better Auth's oauth-provider rejects non-JWT random strings with 400
    // before consulting the token store — either shape is spec-compliant.
    const garbageRes = await app.request("/api/auth/oauth2/introspect", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: "not-a-real-token",
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    expect([200, 400, 401]).toContain(garbageRes.status);
    if (garbageRes.status === 200) {
      const garbageBody = (await garbageRes.json()) as { active?: boolean };
      expect(garbageBody.active).toBe(false);
    }
  });

  it("revoke invalidates a refresh token so it can no longer mint new access tokens", async () => {
    // JWT access tokens are stateless — revocation only meaningfully
    // applies to the refresh token (which is a DB-tracked opaque string).
    // RFC 7009 §2.1 explicitly says the authorization server "SHOULD
    // revoke the refresh token" on revoke. We verify the contract by
    // attempting a refresh after revoke and asserting it fails.
    const { cookie } = await signUpEndUser("revoke@satellite.example.com", "Sup3rSecret!");
    const { code, verifier } = await runHappyPathToCode({ cookie });
    const tokens = await exchangeCodeForTokens(code, verifier);
    expect(tokens.refresh_token).toBeTruthy();

    const revokeRes = await app.request("/api/auth/oauth2/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: tokens.refresh_token!,
        token_type_hint: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    expect(revokeRes.status).toBe(200);

    // A subsequent refresh attempt with the revoked token must fail.
    const refreshAttempt = await app.request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token!,
        client_id: clientId,
        client_secret: clientSecret,
        resource: "http://localhost:3000",
      }).toString(),
    });
    expect([400, 401]).toContain(refreshAttempt.status);
  });
});
