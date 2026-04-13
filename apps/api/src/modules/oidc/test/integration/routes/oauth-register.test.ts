// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the OIDC module's public registration page.
 *
 * Scope: GET rendering, form validation, CSRF enforcement, successful
 * sign-up flow, and duplicate email handling on POST /api/oauth/register.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  authHeaders,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import oidcModule from "../../../index.ts";

const app = getTestApp({ modules: [oidcModule] });

async function registerClient(
  ctx: TestContext,
  overrides: { name?: string; redirectUris?: string[] } = {},
): Promise<{ clientId: string; clientSecret: string }> {
  const body = {
    level: "application" as const,
    name: overrides.name ?? "Register Test App",
    redirectUris: overrides.redirectUris ?? ["https://acme.example.com/oauth/callback"],
    referencedApplicationId: ctx.defaultAppId,
  };
  const res = await app.request("/api/oauth/clients", {
    method: "POST",
    headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { clientId: string; clientSecret: string };
}

/** Extract CSRF token from a GET response (cookie + hidden field). */
async function getCsrfFromGet(res: Response): Promise<{ csrfToken: string; cookie: string }> {
  const cookieHeader = res.headers.get("set-cookie") ?? "";
  const cookie = cookieHeader.split(";")[0]!;
  const html = await res.text();
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  return { csrfToken: match?.[1] ?? "", cookie };
}

describe("Public registration page — /api/oauth/register", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "oidcregister" });
  });

  // ─── GET /api/oauth/register ────────────────────────────────────────────────

  it("GET /register renders a form with name, email, password fields", async () => {
    const { clientId } = await registerClient(ctx);
    const qs = `?client_id=${encodeURIComponent(clientId)}&state=xyz`;
    const res = await app.request(`/api/oauth/register${qs}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('method="POST"');
    expect(html).toContain('name="name"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
  });

  it("GET /register without client_id returns 400 error page", async () => {
    const res = await app.request("/api/oauth/register");
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("manquant");
  });

  it("GET /register with invalid client_id returns error page", async () => {
    const res = await app.request("/api/oauth/register?client_id=invalid");
    const status = res.status;
    expect([400, 404]).toContain(status);
  });

  it("GET /register issues a CSRF cookie matching the hidden form field", async () => {
    const { clientId } = await registerClient(ctx);
    const qs = `?client_id=${encodeURIComponent(clientId)}`;
    const res = await app.request(`/api/oauth/register${qs}`);
    expect(res.status).toBe(200);
    const cookieHeader = res.headers.get("set-cookie") ?? "";
    const cookieMatch = cookieHeader.match(/oidc_csrf=([^;]+)/);
    expect(cookieMatch).not.toBeNull();
    const html = await res.text();
    const formMatch = html.match(/name="_csrf" value="([^"]+)"/);
    expect(formMatch).not.toBeNull();
    expect(formMatch![1]).toBe(cookieMatch![1]);
  });

  it("GET /register includes link back to login page", async () => {
    const { clientId } = await registerClient(ctx);
    const qs = `?client_id=${encodeURIComponent(clientId)}`;
    const res = await app.request(`/api/oauth/register${qs}`);
    const html = await res.text();
    expect(html).toContain("/api/oauth/login");
    expect(html).toContain("Se connecter");
  });

  // ─── POST /api/oauth/register ───────────────────────────────────────────────

  it("POST /register without CSRF token is rejected 403", async () => {
    const { clientId } = await registerClient(ctx);
    const qs = `?client_id=${encodeURIComponent(clientId)}`;
    const res = await app.request(`/api/oauth/register${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "name=Test&email=test@test.com&password=longpassword123",
    });
    expect(res.status).toBe(403);
  });

  it("POST /register without client_id returns 400", async () => {
    const res = await app.request("/api/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "name=Test&email=test@test.com&password=longpassword123",
    });
    expect(res.status).toBe(400);
  });

  it("POST /register with missing fields returns 400 with error message", async () => {
    const { clientId } = await registerClient(ctx);
    const qs = `?client_id=${encodeURIComponent(clientId)}`;

    // GET to obtain CSRF token
    const getRes = await app.request(`/api/oauth/register${qs}`);
    const { csrfToken, cookie } = await getCsrfFromGet(getRes);

    // POST without email
    const res = await app.request(`/api/oauth/register${qs}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
      },
      body: `_csrf=${csrfToken}&name=Test&password=longpassword123`,
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("requis");
  });

  it("POST /register with short password returns 400", async () => {
    const { clientId } = await registerClient(ctx);
    const qs = `?client_id=${encodeURIComponent(clientId)}`;

    const getRes = await app.request(`/api/oauth/register${qs}`);
    const { csrfToken, cookie } = await getCsrfFromGet(getRes);

    const res = await app.request(`/api/oauth/register${qs}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
      },
      body: `_csrf=${csrfToken}&name=Test&email=short@test.com&password=short`,
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("8 caractères");
  });

  it("POST /register with valid data creates user and sets session cookie", async () => {
    const { clientId } = await registerClient(ctx);
    const qs = `?client_id=${encodeURIComponent(clientId)}&state=xyz&scope=openid`;

    const getRes = await app.request(`/api/oauth/register${qs}`);
    const { csrfToken, cookie } = await getCsrfFromGet(getRes);

    const email = `register-${Date.now()}@test.com`;
    const res = await app.request(`/api/oauth/register${qs}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
      },
      body: `_csrf=${csrfToken}&name=Test+User&email=${encodeURIComponent(email)}&password=TestPassword123!`,
    });

    // Should redirect to authorize (302) with session cookie set
    expect([200, 302]).toContain(res.status);
    if (res.status === 302) {
      const location = res.headers.get("location") ?? "";
      expect(location).toContain("/api/auth/oauth2/authorize");
    }
    // Session cookie should be present
    const setCookies = res.headers.get("set-cookie") ?? "";
    expect(setCookies).toContain("better-auth");
  });

  it("POST /register with duplicate email returns 409", async () => {
    const { clientId } = await registerClient(ctx);
    const qs = `?client_id=${encodeURIComponent(clientId)}`;

    // Create a user first
    const email = `dup-${Date.now()}@test.com`;
    await createTestUser({ email, password: "TestPassword123!" });

    const getRes = await app.request(`/api/oauth/register${qs}`);
    const { csrfToken, cookie } = await getCsrfFromGet(getRes);

    const res = await app.request(`/api/oauth/register${qs}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
      },
      body: `_csrf=${csrfToken}&name=Dup+User&email=${encodeURIComponent(email)}&password=TestPassword123!`,
    });

    // Should show error about existing account
    expect([409, 422]).toContain(res.status);
    const html = await res.text();
    expect(html).toContain("existe déjà");
  });
});
