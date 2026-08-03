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

async function setupApplicationClient(): Promise<{ clientId: string }> {
  const ctx = await createTestContext();
  const client = await createClient({
    level: "application",
    name: "Public Origin Test Client",
    redirectUris: ["https://rp.example.test/auth/callback"],
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
    redirect_uri: "https://rp.example.test/auth/callback",
    scope: "openid profile email",
    state: "public-origin-state",
    code_challenge: "x".repeat(43),
    code_challenge_method: "S256",
  });
  const path = `/api/oauth/magic-link?${query.toString()}`;
  const getRes = await app.request(`${INTERNAL_ORIGIN}${path}`);
  expect(getRes.status).toBe(200);
  const cookie = (getRes.headers.get("set-cookie") ?? "").split(";")[0]!;
  const html = await getRes.text();
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error("Missing CSRF token on magic-link page");

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
    expect(new URL(emailedUrl.searchParams.get("callbackURL")!).origin).toBe(PUBLIC_ORIGIN);
    expect(new URL(emailedUrl.searchParams.get("errorCallbackURL")!).origin).toBe(PUBLIC_ORIGIN);
  });

  it("redirects magic-link confirmation to the canonical HTTPS verify endpoint", async () => {
    const { clientId } = await setupApplicationClient();
    await requestMagicLink(clientId, `confirm-${crypto.randomUUID()}@example.test`);
    const emailedUrl = extractFirstEmailUrl(mails[0]!.html);
    const internalConfirmUrl = `${INTERNAL_ORIGIN}${emailedUrl.pathname}${emailedUrl.search}`;

    const getRes = await app.request(internalConfirmUrl);
    expect(getRes.status).toBe(200);
    const cookie = (getRes.headers.get("set-cookie") ?? "").split(";")[0]!;
    const html = await getRes.text();
    const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
    if (!csrf) throw new Error("Missing CSRF token on magic-link confirmation page");

    const postRes = await app.request(internalConfirmUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: `_csrf=${encodeURIComponent(csrf)}`,
    });
    expect(postRes.status).toBe(302);
    const verifyLocation = postRes.headers.get("location");
    expect(verifyLocation).toStartWith(`${PUBLIC_ORIGIN}/api/auth/magic-link/verify?`);

    const verifyRes = await app.request(verifyLocation!);
    expect(verifyRes.status).toBe(302);
    expect(verifyRes.headers.get("location")).toStartWith(
      `${PUBLIC_ORIGIN}/api/auth/oauth2/authorize?`,
    );
  });

  it("sends password-reset links on the canonical HTTPS origin", async () => {
    const { clientId } = await setupApplicationClient();
    const user = await createTestUser({ emailVerified: true });
    const query = new URLSearchParams({
      client_id: clientId,
      state: "public-origin-reset-state",
    });
    const path = `/api/oauth/forgot-password?${query.toString()}`;

    const getRes = await app.request(`${INTERNAL_ORIGIN}${path}`);
    expect(getRes.status).toBe(200);
    const cookie = (getRes.headers.get("set-cookie") ?? "").split(";")[0]!;
    const html = await getRes.text();
    const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
    if (!csrf) throw new Error("Missing CSRF token on forgot-password page");

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
