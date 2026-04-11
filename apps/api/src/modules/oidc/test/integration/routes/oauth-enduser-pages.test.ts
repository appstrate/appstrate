// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the OIDC module's public login + consent pages.
 *
 * Scope: GET rendering + XSS safety + client_id validation + CSRF
 * enforcement on POST. The full Authorization Code + PKCE flow lives in
 * `test/integration/services/oauth-flows.test.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
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

async function registerClient(
  ctx: TestContext,
  body: { name: string; redirectUris: string[] } = {
    name: "Acme Portal",
    redirectUris: ["https://acme.example.com/oauth/callback"],
  },
): Promise<{ clientId: string; clientSecret: string }> {
  const res = await app.request("/api/oauth/clients", {
    method: "POST",
    headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { clientId: string; clientSecret: string };
}

describe("Public end-user pages — /api/oauth/enduser/*", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "oidcpages" });
  });

  it("GET /login renders a form with the escaped query string and no auth required", async () => {
    const { clientId } = await registerClient(ctx);
    const qs = `?client_id=${encodeURIComponent(clientId)}&state=xyz&scope=openid%20runs%3Aread`;
    const res = await app.request(`/api/oauth/enduser/login${qs}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('method="POST"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    // Form action echoes the query string back with `&` HTML-escaped to `&amp;`.
    const escapedQs = qs.replace(/&/g, "&amp;");
    expect(html).toContain(`action="/api/oauth/enduser/login${escapedQs}"`);
  });

  it("GET /login always HTML-escapes `&` in the forwarded query string", async () => {
    // Bun's URL parser percent-encodes literal `<`, `"`, etc. before they reach
    // the route, so those never arrive raw. The vector that DOES arrive intact
    // is `&` — the query-string separator — and it must be escaped to `&amp;`
    // in the form action to satisfy HTML5 attribute parsing. Direct unit tests
    // on `escapeHtml` + `renderLoginPage` cover the raw-character vectors.
    const { clientId } = await registerClient(ctx);
    const qs = `?client_id=${encodeURIComponent(clientId)}&state=x&scope=openid`;
    const res = await app.request(`/api/oauth/enduser/login${qs}`);
    expect(res.status).toBe(200);
    const htmlOut = await res.text();
    expect(htmlOut).not.toContain(`action="/api/oauth/enduser/login${qs}"`);
    expect(htmlOut).toContain(`state=x&amp;scope=openid`);
  });

  it("GET /login 404s on unknown client_id", async () => {
    const res = await app.request(
      "/api/oauth/enduser/login?client_id=oauth_totally_unknown&state=x",
    );
    expect(res.status).toBe(404);
  });

  it("GET /login 400s when client_id is missing", async () => {
    const res = await app.request("/api/oauth/enduser/login?state=x");
    expect(res.status).toBe(400);
  });

  it("GET /login 404s on a disabled client", async () => {
    const { clientId } = await registerClient(ctx);
    await app.request(`/api/oauth/clients/${clientId}`, {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    });
    const res = await app.request(
      `/api/oauth/enduser/login?client_id=${encodeURIComponent(clientId)}`,
    );
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
    const res = await app.request(`/api/oauth/enduser/consent${qs}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Team Portal");
    expect(html).toContain("Consulter votre historique d&#39;exécutions");
    expect(html).toContain("Lancer des agents pour vous");
    // Two forms (deny + allow) both posting back to the same action.
    const escapedQs = qs.replace(/&/g, "&amp;");
    expect(html).toContain(`action="/api/oauth/enduser/consent${escapedQs}"`);
  });

  it("GET /consent escapes XSS in the client name", async () => {
    const { clientId } = await registerClient(ctx, {
      name: `<img src=x onerror=alert(1)>`,
      redirectUris: ["https://x.example.com/cb"],
    });
    const res = await app.request(
      `/api/oauth/enduser/consent?client_id=${encodeURIComponent(clientId)}&scope=openid`,
    );
    const html = await res.text();
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("GET /consent 404s on unknown client_id", async () => {
    const res = await app.request("/api/oauth/enduser/consent?client_id=oauth_nope&scope=openid");
    expect(res.status).toBe(404);
  });

  it("POST /login without a CSRF token is rejected 403", async () => {
    const { clientId } = await registerClient(ctx);
    const res = await app.request(
      `/api/oauth/enduser/login?client_id=${encodeURIComponent(clientId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "email=a@b.com&password=hunter2",
      },
    );
    expect(res.status).toBe(403);
  });

  it("POST /consent without a CSRF token is rejected 403", async () => {
    const { clientId } = await registerClient(ctx);
    const res = await app.request(
      `/api/oauth/enduser/consent?client_id=${encodeURIComponent(clientId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "accept=true",
      },
    );
    expect(res.status).toBe(403);
  });

  it("GET /login issues an httpOnly oidc_csrf cookie that matches the hidden form field", async () => {
    const { clientId } = await registerClient(ctx);
    const res = await app.request(
      `/api/oauth/enduser/login?client_id=${encodeURIComponent(clientId)}`,
    );
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
        `/api/oauth/enduser/login?client_id=${encodeURIComponent(clientId)}`,
      );
      const cookie = (getRes.headers.get("set-cookie") ?? "").split(";")[0]!;
      const formHtml = await getRes.text();
      const csrf = formHtml.match(/name="_csrf" value="([^"]+)"/)![1]!;
      return app.request(`/api/oauth/enduser/login?client_id=${encodeURIComponent(clientId)}`, {
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

  it("POST /login with a valid CSRF but wrong credentials re-renders the form with an error", async () => {
    const { clientId } = await registerClient(ctx);
    const getRes = await app.request(
      `/api/oauth/enduser/login?client_id=${encodeURIComponent(clientId)}`,
    );
    const cookie = (getRes.headers.get("set-cookie") ?? "").split(";")[0]!;
    const html = await getRes.text();
    const csrf = html.match(/name="_csrf" value="([^"]+)"/)![1]!;

    const res = await app.request(
      `/api/oauth/enduser/login?client_id=${encodeURIComponent(clientId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: `_csrf=${encodeURIComponent(csrf)}&email=nobody@example.com&password=wrong`,
      },
    );
    // Credentials bad — 401 with the login form re-rendered, not the 302
    // redirect to the authorize endpoint.
    expect([401, 400]).toContain(res.status);
    const out = await res.text();
    expect(out).toContain("Email ou mot de passe incorrect");
  });
});
