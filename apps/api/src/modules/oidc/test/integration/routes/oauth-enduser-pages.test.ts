// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the OIDC module's public login + consent pages.
 *
 * Scope: GET rendering + XSS safety + client_id validation + CSRF
 * enforcement on POST. The full Authorization Code + PKCE flow lives in
 * `test/integration/services/oauth-flows.test.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { endUsers } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";
import {
  createTestContext,
  createTestUser,
  authHeaders,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import oidcModule from "../../../index.ts";
import { resetOidcGuardsLimiters } from "../../../auth/guards.ts";
import { prefixedId } from "../../../../../lib/ids.ts";

const app = getTestApp({ modules: [oidcModule] });

async function registerClient(
  ctx: TestContext,
  overrides: {
    name?: string;
    redirectUris?: string[];
    allowSignup?: boolean;
  } = {},
): Promise<{ clientId: string; clientSecret: string }> {
  const body = {
    level: "application" as const,
    name: overrides.name ?? "Acme Portal",
    redirectUris: overrides.redirectUris ?? ["https://acme.example.com/oauth/callback"],
    referencedApplicationId: ctx.defaultAppId,
    // Default to JIT ON for the end-user page happy-path tests — they
    // simulate brand-new end-user sign-ups that would otherwise be rejected
    // by the secure-by-default gate.
    allowSignup: overrides.allowSignup ?? true,
  };
  const res = await app.request("/api/oauth/clients", {
    method: "POST",
    headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { clientId: string; clientSecret: string };
}

describe("Public end-user pages — /api/oauth/*", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "oidcpages" });
  });

  it("GET /login renders a form with the escaped query string and no auth required", async () => {
    const { clientId } = await registerClient(ctx);
    const qs = `?client_id=${encodeURIComponent(clientId)}&state=xyz&scope=openid%20runs%3Aread`;
    const res = await app.request(`/api/oauth/login${qs}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('method="POST"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    // Form action echoes the query string back with `&` HTML-escaped to `&amp;`.
    const escapedQs = qs.replace(/&/g, "&amp;");
    expect(html).toContain(`action="/api/oauth/login${escapedQs}"`);
  });

  it("GET /login always HTML-escapes `&` in the forwarded query string", async () => {
    // Bun's URL parser percent-encodes literal `<`, `"`, etc. before they reach
    // the route, so those never arrive raw. The vector that DOES arrive intact
    // is `&` — the query-string separator — and it must be escaped to `&amp;`
    // in the form action to satisfy HTML5 attribute parsing. Direct unit tests
    // on `escapeHtml` + `renderLoginPage` cover the raw-character vectors.
    const { clientId } = await registerClient(ctx);
    const qs = `?client_id=${encodeURIComponent(clientId)}&state=x&scope=openid`;
    const res = await app.request(`/api/oauth/login${qs}`);
    expect(res.status).toBe(200);
    const htmlOut = await res.text();
    expect(htmlOut).not.toContain(`action="/api/oauth/login${qs}"`);
    expect(htmlOut).toContain(`state=x&amp;scope=openid`);
  });

  it("GET /login 404s on unknown client_id", async () => {
    const res = await app.request("/api/oauth/login?client_id=oauth_totally_unknown&state=x");
    expect(res.status).toBe(404);
  });

  it("GET /login 400s when client_id is missing", async () => {
    const res = await app.request("/api/oauth/login?state=x");
    expect(res.status).toBe(400);
  });

  it("GET /login 404s on a disabled client", async () => {
    const { clientId } = await registerClient(ctx);
    await app.request(`/api/oauth/clients/${clientId}`, {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    });
    const res = await app.request(`/api/oauth/login?client_id=${encodeURIComponent(clientId)}`);
    expect(res.status).toBe(404);
  });

  it("GET /consent renders the client name and the requested scopes", async () => {
    const { clientId } = await registerClient(ctx, {
      name: "Team Portal",
      redirectUris: ["https://team.example.com/cb"],
    });
    const qs = `?client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent(
      "openid runs:read agents:run",
    )}&state=s1`;
    const res = await app.request(`/api/oauth/consent${qs}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Team Portal");
    expect(html).toContain("Consulter votre historique d&#39;exécutions");
    expect(html).toContain("Lancer des agents pour vous");
    // Two forms (deny + allow) both posting back to the same action.
    const escapedQs = qs.replace(/&/g, "&amp;");
    expect(html).toContain(`action="/api/oauth/consent${escapedQs}"`);
  });

  it("GET /consent escapes XSS in the client name", async () => {
    const { clientId } = await registerClient(ctx, {
      name: `<img src=x onerror=alert(1)>`,
      redirectUris: ["https://x.example.com/cb"],
    });
    const res = await app.request(
      `/api/oauth/consent?client_id=${encodeURIComponent(clientId)}&scope=openid`,
    );
    const html = await res.text();
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("GET /consent 404s on unknown client_id", async () => {
    const res = await app.request("/api/oauth/consent?client_id=oauth_nope&scope=openid");
    expect(res.status).toBe(404);
  });

  it("POST /login without a CSRF token is rejected 403", async () => {
    const { clientId } = await registerClient(ctx);
    const res = await app.request(`/api/oauth/login?client_id=${encodeURIComponent(clientId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "email=a@b.com&password=hunter2",
    });
    expect(res.status).toBe(403);
  });

  it("POST /consent without a CSRF token is rejected 403", async () => {
    const { clientId } = await registerClient(ctx);
    const res = await app.request(`/api/oauth/consent?client_id=${encodeURIComponent(clientId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "accept=true",
    });
    expect(res.status).toBe(403);
  });

  it("GET /login issues an httpOnly oidc_csrf cookie that matches the hidden form field", async () => {
    const { clientId } = await registerClient(ctx);
    const res = await app.request(`/api/oauth/login?client_id=${encodeURIComponent(clientId)}`);
    expect(res.status).toBe(200);
    const cookieHeader = res.headers.get("set-cookie") ?? "";
    const cookieMatch = cookieHeader.match(/oidc_csrf=([^;]+)/);
    expect(cookieMatch).not.toBeNull();
    const cookieToken = cookieMatch![1]!;
    const html = await res.text();
    const formMatch = html.match(/name="_csrf" value="([^"]+)"/);
    expect(formMatch).not.toBeNull();
    expect(formMatch![1]).toBe(cookieToken);
    // httpOnly + SameSite=Lax for CSRF hardening.
    expect(cookieHeader.toLowerCase()).toContain("httponly");
    expect(cookieHeader.toLowerCase()).toContain("samesite=lax");
  });

  describe("POST /login per-email rate limit (H2)", () => {
    beforeEach(async () => {
      await flushRedis();
      resetOidcGuardsLimiters();
    });

    async function submitLogin(
      clientId: string,
      email: string,
      password: string,
    ): Promise<Response> {
      const getRes = await app.request(
        `/api/oauth/login?client_id=${encodeURIComponent(clientId)}`,
      );
      const cookie = (getRes.headers.get("set-cookie") ?? "").split(";")[0]!;
      const formHtml = await getRes.text();
      const csrf = formHtml.match(/name="_csrf" value="([^"]+)"/)![1]!;
      return app.request(`/api/oauth/login?client_id=${encodeURIComponent(clientId)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie,
        },
        body:
          `_csrf=${encodeURIComponent(csrf)}` +
          `&email=${encodeURIComponent(email)}` +
          `&password=${encodeURIComponent(password)}`,
      });
    }

    it("lets 5 failures through, 429s on the 6th for the same email", async () => {
      const { clientId } = await registerClient(ctx);
      for (let i = 0; i < 5; i++) {
        const res = await submitLogin(clientId, "victim@example.com", "wrong");
        expect(res.status).toBe(401);
      }
      const throttled = await submitLogin(clientId, "victim@example.com", "wrong");
      expect(throttled.status).toBe(429);
      expect(throttled.headers.get("retry-after")).toMatch(/^\d+$/);
      const body = await throttled.text();
      expect(body).toContain("Trop de tentatives");
    });

    it("isolates counters per email — throttling victim@ does not affect other@", async () => {
      const { clientId } = await registerClient(ctx);
      for (let i = 0; i < 6; i++) {
        await submitLogin(clientId, "victim@example.com", "wrong");
      }
      const other = await submitLogin(clientId, "other@example.com", "wrong");
      expect(other.status).toBe(401);
    });

    it("normalizes email case + whitespace (limiter key is lowercased + trimmed)", async () => {
      const { clientId } = await registerClient(ctx);
      for (let i = 0; i < 5; i++) {
        await submitLogin(clientId, "Mixed@Example.COM", "wrong");
      }
      const throttled = await submitLogin(clientId, "  mixed@example.com  ", "wrong");
      expect(throttled.status).toBe(429);
    });
  });

  // C3 — surface `UnverifiedEmailConflictError` while we still control the
  // response. Previously this error fired inside `customAccessTokenClaims`
  // during the subsequent token mint, long after the POST /login handler
  // had already 302'd away, so the user saw an opaque 500. We now pre-
  // resolve the end-user at the end of the login handler and render the
  // friendly FR error page from there.
  it("POST /login proactively detects an unverified email conflict and 409s", async () => {
    const { clientId } = await registerClient(ctx);

    // Seed a distinct end-user row in the same app carrying the conflict
    // email. The auth identity about to sign in has this same email but
    // has NOT verified it — the strict === true guard in
    // `resolveOrCreateEndUser` must refuse to silently adopt the row.
    const conflictEmail = `c3conflict-${Date.now()}@example.com`;
    await db.insert(endUsers).values({
      id: prefixedId("eu"),
      applicationId: ctx.defaultAppId,
      orgId: ctx.org.id,
      externalId: conflictEmail,
      email: conflictEmail,
      name: "Pre-existing",
    });

    // Create the Better Auth user that will attempt the login. Better Auth
    // default sign-up leaves `emailVerified = false`.
    await createTestUser({ email: conflictEmail });

    const getRes = await app.request(`/api/oauth/login?client_id=${encodeURIComponent(clientId)}`);
    const cookie = (getRes.headers.get("set-cookie") ?? "").split(";")[0]!;
    const formHtml = await getRes.text();
    const csrf = formHtml.match(/name="_csrf" value="([^"]+)"/)![1]!;

    const res = await app.request(`/api/oauth/login?client_id=${encodeURIComponent(clientId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        cookie,
      },
      body:
        `_csrf=${encodeURIComponent(csrf)}` +
        `&email=${encodeURIComponent(conflictEmail)}` +
        `&password=TestPassword123!`,
    });

    expect(res.status).toBe(409);
    const body = await res.text();
    // HTML-escaped (apostrophe becomes &#39;) — match on a stable substring.
    expect(body).toContain("pas vérifié");
    expect(body).toContain("Un compte existe déjà");
  });

  it("POST /login with a valid CSRF but wrong credentials re-renders the form with an error", async () => {
    const { clientId } = await registerClient(ctx);
    const getRes = await app.request(`/api/oauth/login?client_id=${encodeURIComponent(clientId)}`);
    const cookie = (getRes.headers.get("set-cookie") ?? "").split(";")[0]!;
    const html = await getRes.text();
    const csrf = html.match(/name="_csrf" value="([^"]+)"/)![1]!;

    const res = await app.request(`/api/oauth/login?client_id=${encodeURIComponent(clientId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        cookie,
      },
      body: `_csrf=${encodeURIComponent(csrf)}&email=nobody@example.com&password=wrong`,
    });
    // Credentials bad — 401 with the login form re-rendered, not the 302
    // redirect to the authorize endpoint.
    expect([401, 400]).toContain(res.status);
    const out = await res.text();
    expect(out).toContain("Email ou mot de passe incorrect");
  });

  // ── Stale login URL protections ────────────────────────────────────────
  // When a user clicks a stale/bookmarked OAuth login link, the login
  // endpoint must not create a persistent BA session that would let any
  // downstream OIDC client silently auto-grant on the next visit.

  describe("expired login URL protection (exp param)", () => {
    it("GET /login with an expired exp param returns 400 with error message", async () => {
      const { clientId } = await registerClient(ctx);
      const pastExp = Math.floor(Date.now() / 1000) - 60; // 1 minute ago
      const qs = `?client_id=${encodeURIComponent(clientId)}&state=stale&exp=${pastExp}&sig=fakesig`;
      const res = await app.request(`/api/oauth/login${qs}`);
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("expiré");
    });

    it("GET /login without exp param still renders normally (BA handles its own signing)", async () => {
      const { clientId } = await registerClient(ctx);
      const qs = `?client_id=${encodeURIComponent(clientId)}&state=fresh`;
      const res = await app.request(`/api/oauth/login${qs}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('method="POST"');
    });

    it("GET /login with a future exp param renders normally", async () => {
      const { clientId } = await registerClient(ctx);
      const futureExp = Math.floor(Date.now() / 1000) + 600; // 10 minutes from now
      const qs = `?client_id=${encodeURIComponent(clientId)}&state=fresh&exp=${futureExp}&sig=test`;
      const res = await app.request(`/api/oauth/login${qs}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('method="POST"');
    });

    it("POST /login with an expired exp param rejects before authenticating", async () => {
      const { clientId } = await registerClient(ctx);
      const pastExp = Math.floor(Date.now() / 1000) - 60;
      const qs = `?client_id=${encodeURIComponent(clientId)}&state=stale&exp=${pastExp}&sig=fake`;
      const res = await app.request(`/api/oauth/login${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "email=a@b.com&password=hunter2",
      });
      expect(res.status).toBe(400);
      // No Set-Cookie with a session token — the user was never authenticated.
      const cookies = res.headers.get("set-cookie") ?? "";
      expect(cookies).not.toContain("better-auth.session_token");
    });
  });

  describe("OAuth login session TTL", () => {
    it("POST /login success forwards BA cookies with Max-Age capped to 300s", async () => {
      const { clientId } = await registerClient(ctx);
      const email = `ttl-${Date.now()}@example.com`;
      const password = "TestPassword123!";
      await createTestUser({ email, password });

      // GET login page to obtain CSRF token + cookie.
      const getRes = await app.request(
        `/api/oauth/login?client_id=${encodeURIComponent(clientId)}`,
      );
      const csrfCookie = (getRes.headers.get("set-cookie") ?? "").split(";")[0]!;
      const formHtml = await getRes.text();
      const csrf = formHtml.match(/name="_csrf" value="([^"]+)"/)![1]!;

      const res = await app.request(`/api/oauth/login?client_id=${encodeURIComponent(clientId)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: csrfCookie,
        },
        body:
          `_csrf=${encodeURIComponent(csrf)}` +
          `&email=${encodeURIComponent(email)}` +
          `&password=${encodeURIComponent(password)}`,
        redirect: "manual",
      });
      // Successful login redirects to the authorize endpoint.
      expect(res.status).toBe(302);

      // Every Set-Cookie from BA must carry Max-Age=300 (5 min cap).
      const allCookies =
        typeof (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie ===
        "function"
          ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
          : (res.headers.get("set-cookie") ?? "").split(",").map((c) => c.trim());
      const sessionCookies = allCookies.filter((c) => c.includes("better-auth.session_token"));
      expect(sessionCookies.length).toBeGreaterThan(0);
      for (const cookie of sessionCookies) {
        expect(cookie).toContain("Max-Age=300");
      }
    });
  });

  describe("Org-level signup policy", () => {
    async function registerOrgClient(
      c: TestContext,
      overrides: { allowSignup?: boolean; signupRole?: "admin" | "member" | "viewer" } = {},
    ): Promise<{ clientId: string }> {
      const body = {
        level: "org" as const,
        name: "Org Portal",
        redirectUris: ["https://orgportal.example.com/cb"],
        referencedOrgId: c.orgId,
        ...overrides,
      };
      const res = await app.request("/api/oauth/clients", {
        method: "POST",
        headers: { ...authHeaders(c), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await res.json()) as { clientId: string };
    }

    it("GET /register renders an error page when allowSignup=false on an org-level client", async () => {
      const { clientId } = await registerOrgClient(ctx, { allowSignup: false });
      const res = await app.request(
        `/api/oauth/register?client_id=${encodeURIComponent(clientId)}&state=x`,
      );
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toContain("Inscription fermée");
      // No form, no CSRF field
      expect(html).not.toContain('name="password"');
    });

    it("GET /register issues the pending-client cookie when allowSignup=true", async () => {
      const { clientId } = await registerOrgClient(ctx, { allowSignup: true });
      const res = await app.request(
        `/api/oauth/register?client_id=${encodeURIComponent(clientId)}&state=x`,
      );
      expect(res.status).toBe(200);
      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("oidc_pending_client=");
    });

    it("GET /login hides the register CTA when allowSignup=false, keeps social + magic-link", async () => {
      const { clientId } = await registerOrgClient(ctx, { allowSignup: false });
      const res = await app.request(
        `/api/oauth/login?client_id=${encodeURIComponent(clientId)}&state=x`,
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      // Password form stays
      expect(html).toContain('name="password"');
      // "Créer un compte" link is hidden (the only signup CTA gated by policy)
      expect(html).not.toContain("Créer un compte");
      // Social + magic-link stay available for existing members — orphan
      // creation is blocked at the BA beforeSignup hook
      // (`oidcBeforeSignupGuard`), so showing them is safe.
    });

    it("POST /login rejects an existing auth user who is not a member and allowSignup=false", async () => {
      // Create a second auth user (not a member of `ctx.orgId`).
      const outsider = await createTestUser({ email: "outsider@example.com" });
      const { clientId } = await registerOrgClient(ctx, { allowSignup: false });

      // Prime CSRF via GET so we have a valid token paired with a cookie.
      const getRes = await app.request(
        `/api/oauth/login?client_id=${encodeURIComponent(clientId)}&state=x`,
      );
      const csrfCookie = (getRes.headers.get("set-cookie") ?? "")
        .split(",")
        .map((c) => c.trim())
        .find((c) => c.startsWith("oidc_csrf="));
      expect(csrfCookie).toBeDefined();
      const csrfToken = csrfCookie!.slice("oidc_csrf=".length).split(";")[0];

      const form = new URLSearchParams({
        _csrf: csrfToken!,
        email: outsider.email,
        // `createTestUser` uses a default password; import to keep in sync
        password: "TestPassword123!",
      });

      const postRes = await app.request(
        `/api/oauth/login?client_id=${encodeURIComponent(clientId)}&state=x`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            cookie: csrfCookie!,
          },
          body: form.toString(),
        },
      );
      expect(postRes.status).toBe(403);
      const html = await postRes.text();
      // HTML-escaped apostrophe — the renderer runs the error string
      // through the same `escapeHtml` the rest of the layout uses.
      expect(html).toContain("n&#39;est pas membre");
    });

    it("POST /login auto-joins an existing auth user as signupRole when allowSignup=true", async () => {
      const outsider = await createTestUser({ email: "newbie@example.com" });
      const { clientId } = await registerOrgClient(ctx, {
        allowSignup: true,
        signupRole: "admin",
      });

      const getRes = await app.request(
        `/api/oauth/login?client_id=${encodeURIComponent(clientId)}&state=x`,
      );
      const csrfCookie = (getRes.headers.get("set-cookie") ?? "")
        .split(",")
        .map((c) => c.trim())
        .find((c) => c.startsWith("oidc_csrf="));
      const csrfToken = csrfCookie!.slice("oidc_csrf=".length).split(";")[0];

      const form = new URLSearchParams({
        _csrf: csrfToken!,
        email: outsider.email,
        password: "TestPassword123!",
      });

      const postRes = await app.request(
        `/api/oauth/login?client_id=${encodeURIComponent(clientId)}&state=x`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            cookie: csrfCookie!,
          },
          body: form.toString(),
        },
      );
      // Successful login → 302 redirect to /api/auth/oauth2/authorize.
      expect(postRes.status).toBe(302);
      expect(postRes.headers.get("location")).toContain("/api/auth/oauth2/authorize");

      // Membership row was created with the configured role.
      const { organizationMembers } = await import("@appstrate/db/schema");
      const { and, eq: eqOp } = await import("drizzle-orm");
      const [row] = await db
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(
          and(
            eqOp(organizationMembers.userId, outsider.id),
            eqOp(organizationMembers.orgId, ctx.orgId),
          ),
        );
      expect(row?.role).toBe("admin");
    });
  });

  describe("Application-level signup policy (unified with org/instance)", () => {
    // Symmetric to the org-level tests above — since commit a2aae3af the
    // `allowSignup` flag is honored uniformly across all client levels
    // (SOTA alignment with FusionAuth/Auth0/Okta: CTA hidden when closed,
    // not show-and-reject).

    it("GET /login hides the 'Créer un compte' CTA when allowSignup=false on an app client", async () => {
      const { clientId } = await registerClient(ctx, { allowSignup: false });
      const res = await app.request(
        `/api/oauth/login?client_id=${encodeURIComponent(clientId)}&state=x`,
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('name="password"');
      expect(html).not.toContain("Créer un compte");
    });

    it("GET /register renders an error page when allowSignup=false on an app client", async () => {
      const { clientId } = await registerClient(ctx, { allowSignup: false });
      const res = await app.request(
        `/api/oauth/register?client_id=${encodeURIComponent(clientId)}&state=x`,
      );
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toContain("Inscription fermée");
      expect(html).not.toContain('name="password"');
    });

    it("POST /register rejects with 403 when allowSignup=false on an app client", async () => {
      const { clientId } = await registerClient(ctx, { allowSignup: false });
      const res = await app.request(
        `/api/oauth/register?client_id=${encodeURIComponent(clientId)}&state=x`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "email=a@b.com&password=TestPassword123!&name=A",
        },
      );
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toContain("Inscription fermée");
    });

    it("GET /login keeps the 'Créer un compte' CTA when allowSignup=true on an app client", async () => {
      const { clientId } = await registerClient(ctx, { allowSignup: true });
      const res = await app.request(
        `/api/oauth/login?client_id=${encodeURIComponent(clientId)}&state=x`,
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Créer un compte");
    });
  });
});
