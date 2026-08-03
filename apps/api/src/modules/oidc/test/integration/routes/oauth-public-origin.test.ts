// SPDX-License-Identifier: Apache-2.0

/**
 * Public-origin regressions for OIDC email flows behind a TLS-terminating
 * reverse proxy. The browser reaches APP_URL over HTTPS while Bun receives an
 * internal HTTP request from the proxy. Every URL that leaves the process must
 * stay pinned to APP_URL rather than inherit the internal request scheme.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { _rebuildAuthForTesting } from "@appstrate/db/auth";
import { _resetCacheForTesting } from "@appstrate/env";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { createTestContext, createTestUser } from "../../../../../../test/helpers/auth.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import oidcModule from "../../../index.ts";
import { createClient, _resetClientCache } from "../../../services/oauth-admin.ts";
import {
  _clearSmtpCacheForTesting,
  _setSmtpSpy,
  upsertSmtpConfig,
  type SpiedSmtpSend,
} from "../../../services/smtp.ts";

const PUBLIC_ORIGIN = "https://app.example.test";
const INTERNAL_ORIGIN = "http://app.example.test";
const REDIRECT_URI = "https://rp.example.test/auth/callback";
const OAUTH_STATE = "public-origin-state";
const CODE_CHALLENGE = "x".repeat(43);
const RESOURCE = `${PUBLIC_ORIGIN}/api/auth`;
const EXPIRY = "4102444800";
const BETTER_AUTH_ISSUED_AT = "1785737648922";
const TRANSACTION_SIGNATURE = "signed+/value=";
const app = getTestApp({ modules: [oidcModule] });

const TEST_ENV = {
  APP_URL: PUBLIC_ORIGIN,
  TRUSTED_ORIGINS: PUBLIC_ORIGIN,
  SMTP_HOST: "__test_json__",
  SMTP_PORT: "587",
  SMTP_USER: "test-user",
  SMTP_PASS: "test-pass",
  SMTP_FROM: "test@app.example.test",
} as const;

function extractFirstEmailUrl(html: string): URL {
  const match = html.match(/href="([^"]+)"/);
  if (!match?.[1]) throw new Error(`No link found in email HTML: ${html}`);
  return new URL(match[1].replaceAll("&amp;", "&"));
}

function expectOAuthTransaction(url: URL, clientId: string, pathname: string): void {
  expect(url.origin).toBe(PUBLIC_ORIGIN);
  expect(url.pathname).toBe(pathname);
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("client_id")).toBe(clientId);
  expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
  expect(url.searchParams.get("scope")).toBe("openid profile email");
  expect(url.searchParams.get("state")).toBe(OAUTH_STATE);
  expect(url.searchParams.get("code_challenge")).toBe(CODE_CHALLENGE);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("resource")).toBe(RESOURCE);
  expect(url.searchParams.get("exp")).toBe(EXPIRY);
  expect(url.searchParams.get("ba_iat")).toBe(BETTER_AUTH_ISSUED_AT);
  expect(url.searchParams.get("sig")).toBe(TRANSACTION_SIGNATURE);
}

async function openCsrfForm(url: string): Promise<{ cookie: string; csrf: string }> {
  const response = await app.request(url);
  expect(response.status).toBe(200);
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  const html = await response.text();
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error(`Missing CSRF token at ${new URL(url, INTERNAL_ORIGIN).pathname}`);
  return { cookie, csrf };
}

async function setupApplicationClient(): Promise<{ clientId: string }> {
  const ctx = await createTestContext();
  const client = await createClient({
    level: "application",
    name: "Public Origin Test Client",
    redirectUris: [REDIRECT_URI],
    referencedApplicationId: ctx.defaultAppId,
    allowSignup: true,
  });
  await upsertSmtpConfig(ctx.defaultAppId, {
    host: "__test_json__",
    port: 587,
    username: "test",
    pass: "test",
    fromAddress: "no-reply@app.example.test",
    fromName: "Public Origin Test",
  });
  return { clientId: client.clientId };
}

async function requestMagicLink(clientId: string, email: string): Promise<void> {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email",
    state: OAUTH_STATE,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    resource: RESOURCE,
    exp: EXPIRY,
    ba_iat: BETTER_AUTH_ISSUED_AT,
    sig: TRANSACTION_SIGNATURE,
  });
  const path = `/api/oauth/magic-link?${query.toString()}`;
  const { cookie, csrf } = await openCsrfForm(`${INTERNAL_ORIGIN}${path}`);

  const postRes = await app.request(`${INTERNAL_ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: `_csrf=${encodeURIComponent(csrf)}&email=${encodeURIComponent(email)}`,
  });
  expect(postRes.status).toBe(200);
}

describe("OIDC public URLs behind a TLS-terminating proxy", () => {
  const savedEnv: Record<keyof typeof TEST_ENV, string | undefined> = {
    APP_URL: undefined,
    TRUSTED_ORIGINS: undefined,
    SMTP_HOST: undefined,
    SMTP_PORT: undefined,
    SMTP_USER: undefined,
    SMTP_PASS: undefined,
    SMTP_FROM: undefined,
  };
  let mails: SpiedSmtpSend[] = [];

  beforeAll(() => {
    for (const [key, value] of Object.entries(TEST_ENV)) {
      savedEnv[key as keyof typeof TEST_ENV] = process.env[key];
      process.env[key] = value;
    }
    _resetCacheForTesting();
    _rebuildAuthForTesting();
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetCacheForTesting();
    _rebuildAuthForTesting();
  });

  beforeEach(async () => {
    await truncateAll();
    _resetClientCache();
    _clearSmtpCacheForTesting();
    mails = [];
    _setSmtpSpy((mail) => mails.push(mail));
  });

  afterEach(() => {
    _setSmtpSpy(null);
  });

  it("keeps emailed magic-link callbacks on the canonical HTTPS origin", async () => {
    const { clientId } = await setupApplicationClient();
    await requestMagicLink(clientId, `magic-${crypto.randomUUID()}@example.test`);

    expect(mails).toHaveLength(1);
    const emailedUrl = extractFirstEmailUrl(mails[0]!.html);
    expect(emailedUrl.origin).toBe(PUBLIC_ORIGIN);
    expect(emailedUrl.pathname).toBe("/api/oauth/magic-link/confirm");
    expectOAuthTransaction(
      new URL(emailedUrl.searchParams.get("callbackURL")!),
      clientId,
      "/api/auth/oauth2/authorize",
    );
    expectOAuthTransaction(
      new URL(emailedUrl.searchParams.get("errorCallbackURL")!),
      clientId,
      "/api/oauth/login",
    );
  });

  it("redirects magic-link confirmation to the canonical HTTPS verify endpoint", async () => {
    const { clientId } = await setupApplicationClient();
    await requestMagicLink(clientId, `confirm-${crypto.randomUUID()}@example.test`);
    const emailedUrl = extractFirstEmailUrl(mails[0]!.html);
    const internalConfirmUrl = `${INTERNAL_ORIGIN}${emailedUrl.pathname}${emailedUrl.search}`;

    const { cookie, csrf } = await openCsrfForm(internalConfirmUrl);

    const postRes = await app.request(internalConfirmUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: `_csrf=${encodeURIComponent(csrf)}`,
    });
    expect(postRes.status).toBe(302);
    const verifyLocation = postRes.headers.get("location");
    expect(verifyLocation).toStartWith(`${PUBLIC_ORIGIN}/api/auth/magic-link/verify?`);

    const invalidVerifyUrl = new URL(verifyLocation!);
    invalidVerifyUrl.searchParams.set("token", "invalid-token");
    const invalidVerifyRes = await app.request(invalidVerifyUrl);
    expect(invalidVerifyRes.status).toBe(302);
    const errorUrl = new URL(invalidVerifyRes.headers.get("location")!);
    expectOAuthTransaction(errorUrl, clientId, "/api/oauth/login");
    expect(errorUrl.searchParams.get("error")).toBe("INVALID_TOKEN");

    const verifyRes = await app.request(verifyLocation!);
    expect(verifyRes.status).toBe(302);
    const authorizeUrl = new URL(verifyRes.headers.get("location")!);
    expectOAuthTransaction(authorizeUrl, clientId, "/api/auth/oauth2/authorize");
  });

  it("sends password-reset links on the canonical HTTPS origin", async () => {
    const { clientId } = await setupApplicationClient();
    const user = await createTestUser({ emailVerified: true });
    const query = new URLSearchParams({
      client_id: clientId,
      state: "public-origin-reset-state",
    });
    const path = `/api/oauth/forgot-password?${query.toString()}`;

    const { cookie, csrf } = await openCsrfForm(`${INTERNAL_ORIGIN}${path}`);

    const postRes = await app.request(`${INTERNAL_ORIGIN}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: `_csrf=${encodeURIComponent(csrf)}&email=${encodeURIComponent(user.email)}`,
    });
    expect(postRes.status).toBe(200);
    expect(mails).toHaveLength(1);

    const emailedUrl = extractFirstEmailUrl(mails[0]!.html);
    expect(emailedUrl.origin).toBe(PUBLIC_ORIGIN);
    expect(new URL(emailedUrl.searchParams.get("callbackURL")!).origin).toBe(PUBLIC_ORIGIN);
  });
});
