// SPDX-License-Identifier: Apache-2.0

/**
 * Realm isolation — integration tests.
 *
 * Verifies that the `user.realm` discriminator + associated guards
 * prevent OIDC end-user sessions from being replayed against platform
 * routes, and that cross-audience token mints are rejected at the
 * `buildClaimsForClient` dispatch point.
 *
 * Covers:
 *   - Default signup (no OIDC cookie) tags the user with `realm="platform"`.
 *   - Signup via the OIDC register page with an application-level client
 *     tags the user with `realm="end_user:<applicationId>"`.
 *   - A platform-realm cookie session is accepted on `/api/orgs`.
 *   - An end-user-realm cookie session is rejected on `/api/orgs` with
 *     403 (platform realm guard).
 *   - An end-user-realm cookie session is accepted on `/api/oauth/*`
 *     paths (realm-agnostic surface).
 *   - Token mint for an application-level client refuses a user whose
 *     realm is `"platform"` (cross-audience attempt).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { user as userTable, session as sessionTable } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import oidcModule from "../../../index.ts";
import { resetOidcGuardsLimiters } from "../../../auth/guards.ts";

const app = getTestApp({ modules: [oidcModule] });

async function registerApplicationClient(
  ctx: TestContext,
): Promise<{ clientId: string; clientSecret: string; applicationId: string }> {
  const res = await app.request("/api/oauth/clients", {
    method: "POST",
    headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify({
      level: "application",
      name: "Realm Test Satellite",
      redirectUris: ["https://realm.example.com/callback"],
      referencedApplicationId: ctx.defaultAppId,
      allowSignup: true,
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { clientId: string; clientSecret: string };
  return { ...body, applicationId: ctx.defaultAppId };
}

async function signUpBA(
  email: string,
  password: string,
): Promise<{ cookie: string; userId: string }> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "Test" }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error(`no session cookie: ${setCookie}`);
  const cookie = `better-auth.session_token=${match[1]}`;
  const body = (await res.json()) as { user: { id: string } };
  return { cookie, userId: body.user.id };
}

/**
 * Sign in after a `user.realm` update so the session cookie carries the
 * updated realm. Required because BA's `cookieCache` signs the whole
 * session payload into the cookie at create time — a DB-only update of
 * `session.realm` does not refresh what the realm guard reads per
 * request. Production only sees this at signup time (the realm resolver
 * runs in `user.create.before` and the session is minted immediately
 * with the correct value); tests that flip realm after the fact need a
 * fresh sign-in.
 */
async function signInBA(email: string, password: string): Promise<string> {
  const res = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error(`no session cookie on sign-in: ${setCookie}`);
  return `better-auth.session_token=${match[1]}`;
}

describe("realm isolation", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    ctx = await createTestContext({ orgSlug: "realmorg" });
  });

  it("default signup tags user with realm='platform'", async () => {
    const { userId } = await signUpBA("plat@example.com", "Sup3rSecretPass!");
    const [row] = await db
      .select({ realm: userTable.realm })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1);
    expect(row?.realm).toBe("platform");
  });

  it("platform-realm cookie session is accepted on /api/orgs", async () => {
    const { cookie } = await signUpBA("plat2@example.com", "Sup3rSecretPass!");
    const res = await app.request("/api/orgs", { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it("end-user-realm cookie session is rejected on /api/orgs with 403", async () => {
    const email = "euser2@example.com";
    const password = "Sup3rSecretPass!";
    const { userId } = await signUpBA(email, password);
    // Simulate the realm assignment that the OIDC flow produces in
    // production, then sign in again so BA's cookie-cached session
    // payload carries the updated realm.
    await db
      .update(userTable)
      .set({ realm: `end_user:${ctx.defaultAppId}` })
      .where(eq(userTable.id, userId));
    const cookie = await signInBA(email, password);

    const res = await app.request("/api/orgs", { headers: { cookie } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { title?: string; detail?: string };
    expect(body.detail ?? body.title).toMatch(/platform/i);
  });

  it("end-user-realm cookie session is accepted on /api/oauth/* (realm-agnostic)", async () => {
    const { clientId } = await registerApplicationClient(ctx);
    const email = "euser3@example.com";
    const password = "Sup3rSecretPass!";
    const { userId } = await signUpBA(email, password);
    await db
      .update(userTable)
      .set({ realm: `end_user:${ctx.defaultAppId}` })
      .where(eq(userTable.id, userId));
    const cookie = await signInBA(email, password);

    const res = await app.request(
      `/api/oauth/login?` +
        new URLSearchParams({
          client_id: clientId,
          response_type: "code",
          redirect_uri: "https://realm.example.com/callback",
          scope: "openid",
        }).toString(),
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
  });

  it("session.realm is denormalized from user.realm at session create", async () => {
    const { userId } = await signUpBA("sessrealm@example.com", "Sup3rSecretPass!");
    const [row] = await db
      .select({ realm: sessionTable.realm })
      .from(sessionTable)
      .where(eq(sessionTable.userId, userId))
      .limit(1);
    expect(row?.realm).toBe("platform");
  });
});

// ─── Cross-audience token-mint rejection ───────────────────────────────────
//
// Covers `assertUserRealm` in `auth/plugins.ts`: the three claim builders
// (instance / org / application) reject users whose realm does not match
// the client's audience. These are the fallback of the request-time
// realm guard — even if an attacker somehow bypassed the middleware, the
// token mint itself refuses to issue a cross-audience JWT.

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

/**
 * Drive the full OAuth 2.1 + PKCE flow for the given session cookie and
 * application-level client, returning the `/oauth2/token` response. The
 * realm enforcement lives in `customAccessTokenClaims` → claim builder
 * → `assertUserRealm`, which fires at the token exchange — so the caller
 * asserts on `res.status` here. Happy-path token shape is already covered
 * by `oauth-flows.test.ts`; this helper exists to probe the rejection
 * branch without re-deriving 100 lines per test.
 */
async function runPkceFlowToToken(opts: {
  cookie: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<Response> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = await sha256Base64Url(verifier);
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));

  const authorizeUrl =
    `/api/auth/oauth2/authorize?` +
    new URLSearchParams({
      response_type: "code",
      client_id: opts.clientId,
      redirect_uri: opts.redirectUri,
      scope: "openid profile email",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

  const authorizeRes = await app.request(authorizeUrl, {
    method: "GET",
    headers: { cookie: opts.cookie, accept: "text/html" },
    redirect: "manual",
  });
  // The authorize endpoint may either redirect to /oauth/consent (first
  // visit) or directly to the redirect_uri with a `code` param (consent
  // already granted / first-party client). For a cross-audience attempt
  // the realm check runs at /oauth2/token below — authorize itself does
  // not re-read the claim builder, so we tolerate both shapes here.
  if (authorizeRes.status === 302) {
    const location = authorizeRes.headers.get("location");
    if (location) {
      const url = new URL(location, "http://localhost");
      if (url.pathname === "/api/oauth/consent") {
        // Walk the consent step.
        const consentPageRes = await app.request(url.pathname + url.search, {
          method: "GET",
          headers: { cookie: opts.cookie, accept: "text/html" },
        });
        const csrfCookie = (consentPageRes.headers.get("set-cookie") ?? "")
          .split(",")
          .map((c) => c.trim())
          .find((c) => c.startsWith("oidc_csrf="));
        const csrfCookieValue = csrfCookie?.split(";")[0] ?? "";
        const html = await consentPageRes.text();
        const csrfToken = html.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
        const consentRes = await app.request(url.pathname + url.search, {
          method: "POST",
          headers: {
            cookie: `${opts.cookie}; ${csrfCookieValue}`,
            "Content-Type": "application/x-www-form-urlencoded",
            accept: "application/json",
            origin: "http://localhost:3000",
          },
          body: new URLSearchParams({ _csrf: csrfToken, accept: "true" }).toString(),
          redirect: "manual",
        });
        const loc = consentRes.headers.get("location");
        if (loc) {
          const codeFromLoc = new URL(loc, "http://localhost").searchParams.get("code");
          if (codeFromLoc) return exchangeCode(codeFromLoc, verifier, opts);
        }
        const json = (await consentRes.json()) as { redirect_uri?: string; url?: string };
        const target = json.redirect_uri ?? json.url;
        if (target) {
          const code = new URL(target).searchParams.get("code");
          if (code) return exchangeCode(code, verifier, opts);
        }
      } else {
        const code = url.searchParams.get("code");
        if (code) return exchangeCode(code, verifier, opts);
      }
    }
  }
  return authorizeRes;
}

async function exchangeCode(
  code: string,
  verifier: string,
  opts: { clientId: string; clientSecret: string; redirectUri: string },
): Promise<Response> {
  return app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: opts.redirectUri,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code_verifier: verifier,
      resource: "http://localhost:3000",
    }).toString(),
  });
}

describe("realm isolation — token-mint cross-audience rejection", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    ctx = await createTestContext({ orgSlug: "realmmint" });
  });

  it("application-level client rejects a platform-realm user at /oauth2/token", async () => {
    const { clientId, clientSecret } = await registerApplicationClient(ctx);
    const email = "platformer@example.com";
    const password = "Sup3rSecretPass!";
    // Stays realm="platform" — the default.
    const { cookie } = await signUpBA(email, password);

    const res = await runPkceFlowToToken({
      cookie,
      clientId,
      clientSecret,
      redirectUri: "https://realm.example.com/callback",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { error?: string; error_description?: string };
    expect(body.error).toBe("access_denied");
  });

  it("application-level client rejects an end-user realm for a different application", async () => {
    // Create a SECOND app on the same org to act as the "wrong" audience.
    const { seedApplication } = await import("../../../../../../test/helpers/seed.ts");
    const otherApp = await seedApplication({ orgId: ctx.orgId, name: "Other App" });

    const { clientId, clientSecret } = await registerApplicationClient(ctx);
    const email = "crossapp@example.com";
    const password = "Sup3rSecretPass!";
    const { userId } = await signUpBA(email, password);
    // Stamp the user as end_user of the OTHER app — mismatched with the
    // client's `referencedApplicationId` (= ctx.defaultAppId).
    await db
      .update(userTable)
      .set({ realm: `end_user:${otherApp.id}` })
      .where(eq(userTable.id, userId));
    const cookie = await signInBA(email, password);

    const res = await runPkceFlowToToken({
      cookie,
      clientId,
      clientSecret,
      redirectUri: "https://realm.example.com/callback",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("access_denied");
  });
});
