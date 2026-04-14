// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the email-verification flow in the OIDC module
 * when SMTP is enabled on Better Auth.
 *
 * These tests exist because the default test preload deletes the SMTP
 * env vars, which meant every previous OIDC test ran with
 * `requireEmailVerification: false` — BA created a session on signup and
 * accepted unverified logins, so none of the verify-email branches were
 * exercised. Four bugs slipped through as a result:
 *
 *   1. Social signups were locked on the verification screen because
 *      `databaseHooks.user.create.before` never flipped `emailVerified`
 *      for trusted providers.
 *   2. Email/password signup in SMTP mode redirected to the authorize
 *      endpoint with no session, silently bouncing the user back to
 *      `/login` instead of a "check your email" interstitial.
 *   3. Unverified login showed "Email ou mot de passe incorrect" instead
 *      of a dedicated EMAIL_NOT_VERIFIED message (and no resend happened).
 *   4. The verification link in the email pointed at `/` instead of the
 *      OIDC `authorize` endpoint, breaking third-party OAuth flows after
 *      the click.
 *
 * `enableSmtpForSuite()` rebuilds the Better Auth singleton with SMTP
 * turned on (via the `__test_json__` sentinel host that swaps nodemailer
 * for its built-in jsonTransport so no network call is ever made). The
 * setup helpers here bypass BA sign-up entirely and create rows via the
 * internal service layer — BA sign-up in SMTP mode returns no session,
 * which breaks the standard `createTestContext` helper.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  user as userTable,
  organizations,
  organizationMembers,
  applications,
} from "@appstrate/db/schema";
import { getAuth } from "@appstrate/db/auth";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { enableSmtpForSuite } from "../../../../../../test/helpers/smtp.ts";
import { createClient } from "../../../services/oauth-admin.ts";
import { _resetClientCache } from "../../../services/oauth-admin.ts";
import { upsertSmtpConfig } from "../../../services/smtp-admin.ts";
import { _clearSmtpCacheForTesting } from "../../../services/smtp-config.ts";
import oidcModule from "../../../index.ts";

const app = getTestApp({ modules: [oidcModule] });

/**
 * Provision a fresh {user, org, application, oauth client} tuple without
 * going through BA sign-up. BA in SMTP mode refuses to return a session,
 * which is exactly the behavior under test — but it also means we can't
 * use the default helpers to set up the admin context, so we insert the
 * base rows directly and mint the OAuth client via the `createClient`
 * service. BA accepts sign-in on existing rows when `emailVerified=true`,
 * so the test can still POST to `/api/oauth/login` with real credentials
 * where needed.
 */
async function setupSmtpFixture(): Promise<{
  orgId: string;
  defaultAppId: string;
  clientId: string;
}> {
  // Create a throwaway "owner" user row. No password — this user is only
  // used to satisfy `createdBy` FKs, never to sign in.
  const ownerId = `user-${crypto.randomUUID()}`;
  await db.insert(userTable).values({
    id: ownerId,
    email: `owner-${ownerId}@test.local`,
    name: "Owner",
    emailVerified: true,
  });

  const [org] = await db
    .insert(organizations)
    .values({
      name: "Verify Email Org",
      slug: `verify-${crypto.randomUUID().slice(0, 8)}`,
      createdBy: ownerId,
    })
    .returning();
  await db.insert(organizationMembers).values({ orgId: org!.id, userId: ownerId, role: "owner" });

  const appId = `app_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(applications).values({
    id: appId,
    orgId: org!.id,
    name: "Default",
    isDefault: true,
    createdBy: ownerId,
  });

  const client = await createClient({
    level: "application",
    name: "Verify Email Client",
    redirectUris: ["https://acme.example.com/oauth/callback"],
    referencedApplicationId: appId,
    // This suite exercises brand-new end-user sign-ups through the
    // OIDC verify-email / magic-link / password flows — JIT provisioning
    // must be ON for the happy-path tests to mint a token.
    allowSignup: true,
  });

  // Per-app SMTP is now required for email features on level=application
  // clients (instance env SMTP is no longer used as fallback for tenant
  // flows — it would mix customer email traffic on the platform domain).
  // Wire a jsonTransport config here so the verify-email / magic-link /
  // forgot-password branches stay reachable under test.
  await upsertSmtpConfig(appId, {
    host: "__test_json__",
    port: 587,
    username: "test",
    pass: "test",
    fromAddress: `no-reply@${appId}.test`,
    fromName: "Verify Email App",
  });

  return { orgId: org!.id, defaultAppId: appId, clientId: client.clientId };
}

async function getCsrfFromGet(res: Response): Promise<{ csrfToken: string; cookie: string }> {
  const cookieHeader = res.headers.get("set-cookie") ?? "";
  const cookie = cookieHeader.split(";")[0]!;
  const html = await res.text();
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  return { csrfToken: match?.[1] ?? "", cookie };
}

/** Create an email/password BA account via `signUpEmail` (no session in SMTP mode). */
async function signUpEmailPassword(email: string, password: string): Promise<void> {
  const authApi = getAuth().api;
  await authApi.signUpEmail({
    body: { email, password, name: email.split("@")[0]! },
    asResponse: true,
  });
}

describe("OIDC email verification flow — SMTP enabled", () => {
  enableSmtpForSuite();

  let fixture: { orgId: string; defaultAppId: string; clientId: string };

  beforeEach(async () => {
    await truncateAll();
    _resetClientCache();
    _clearSmtpCacheForTesting();
    fixture = await setupSmtpFixture();
  });

  // ─── Signup interstitial ────────────────────────────────────────────────

  it("POST /register renders the verify-email interstitial (no session, user.emailVerified=false)", async () => {
    const qs = `?client_id=${encodeURIComponent(fixture.clientId)}&state=xyz&scope=openid`;

    const getRes = await app.request(`/api/oauth/register${qs}`);
    const { csrfToken, cookie } = await getCsrfFromGet(getRes);

    const email = `signup-${Date.now()}@test.com`;
    const res = await app.request(`/api/oauth/register${qs}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
      },
      body: `_csrf=${csrfToken}&name=New+User&email=${encodeURIComponent(email)}&password=TestPassword123!`,
    });

    // Inline HTML interstitial, not a 302 redirect.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("Vérifiez votre email");
    expect(html).toContain(email);
    // No BA session cookie — `requireEmailVerification` blocks it.
    const setCookies = res.headers.get("set-cookie") ?? "";
    expect(setCookies).not.toContain("better-auth.session");

    // The user row exists with emailVerified=false.
    const [row] = await db
      .select({ emailVerified: userTable.emailVerified })
      .from(userTable)
      .where(eq(userTable.email, email))
      .limit(1);
    expect(row).toBeDefined();
    expect(row?.emailVerified).toBe(false);
  });

  // ─── Unverified login flow ──────────────────────────────────────────────

  it("POST /login with an unverified account renders the interstitial instead of 'bad credentials'", async () => {
    const qs = `?client_id=${encodeURIComponent(fixture.clientId)}&state=login`;

    // Create an account via BA — SMTP mode leaves it unverified.
    const email = `unverified-${Date.now()}@test.com`;
    const password = "TestPassword123!";
    await signUpEmailPassword(email, password);
    // Sanity check: the user is indeed unverified in DB.
    const [dbRow] = await db
      .select({ emailVerified: userTable.emailVerified })
      .from(userTable)
      .where(eq(userTable.email, email))
      .limit(1);
    expect(dbRow?.emailVerified).toBe(false);

    const getRes = await app.request(`/api/oauth/login${qs}`);
    const { csrfToken, cookie } = await getCsrfFromGet(getRes);

    const res = await app.request(`/api/oauth/login${qs}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
      },
      body: `_csrf=${csrfToken}&email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`,
    });

    // Expect the interstitial (200 HTML), NOT the generic 401 error.
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Vérifiez votre email");
    expect(html).toContain(email);
    expect(html).not.toContain("Email ou mot de passe incorrect");
  });

  it("POST /login with a verified account still signs in normally (no regression in SMTP mode)", async () => {
    const qs = `?client_id=${encodeURIComponent(fixture.clientId)}&state=verified`;

    const email = `verified-${Date.now()}@test.com`;
    const password = "TestPassword123!";
    await signUpEmailPassword(email, password);
    // Simulate the user having clicked the verification link — flip the
    // flag in DB so BA's sign-in accepts the password.
    await db.update(userTable).set({ emailVerified: true }).where(eq(userTable.email, email));

    const getRes = await app.request(`/api/oauth/login${qs}`);
    const { csrfToken, cookie } = await getCsrfFromGet(getRes);

    const res = await app.request(`/api/oauth/login${qs}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
      },
      body: `_csrf=${csrfToken}&email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`,
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/api/auth/oauth2/authorize");
  });
});
