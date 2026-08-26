// SPDX-License-Identifier: Apache-2.0

/**
 * E2E matrix for per-space SMTP across OIDC flows (signup / magic-link /
 * forgot-password). Verifies the two invariants that the phase-5
 * routes.ts wiring guarantees:
 *
 *   1. `level=space` clients without a per-space `space_smtp_configs`
 *      row get NO per-space email transport (no fallback to env SMTP for tenant
 *      mail). With instance SMTP on, signup renders the "check your email"
 *      interstitial and leaves `user.emailVerified=false` — it is NEVER
 *      auto-verified (that was an identity-squat hole). Magic-link and
 *      forgot-password return 404.
 *   2. `level=space` clients WITH a per-space config route every mail
 *      through the per-space transport (verified via the resolver spy). Signup
 *      renders the interstitial and leaves `user.emailVerified=false`.
 *
 * Env SMTP is enabled for the whole suite (via `enableSmtpForSuite`) so the
 * no-per-space-SMTP branch is actually exercised — it is gated on
 * `isInstanceSmtpEnabled()` to guarantee BA's `requireEmailVerification:
 * true` path (session withheld pending verification) is the one being
 * handled, not the trivial SMTP-off path.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { prefixedId } from "../../../../../lib/ids.ts";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { getAuth } from "@appstrate/db/auth";
import {
  user as userTable,
  organizations,
  organizationMembers,
  spaces,
} from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { enableSmtpForSuite } from "../../../../../../test/helpers/smtp.ts";
import { createClient, _resetClientCache } from "../../../services/oauth-admin.ts";
import {
  upsertSmtpConfig,
  _clearSmtpCacheForTesting,
  _setSmtpSpy,
  type SpiedSmtpSend,
} from "../../../services/smtp.ts";
import oidcModule from "../../../index.ts";

const app = getTestApp({ modules: [oidcModule] });

async function setupSpaceClient(opts: { smtp: boolean }): Promise<{
  spaceId: string;
  clientId: string;
}> {
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
      name: "Per-Space SMTP",
      slug: `smtp-e2e-${crypto.randomUUID().slice(0, 8)}`,
      createdBy: ownerId,
    })
    .returning();
  await db.insert(organizationMembers).values({ orgId: org!.id, userId: ownerId, role: "owner" });

  const spaceId = prefixedId("spc");
  await db.insert(spaces).values({
    id: spaceId,
    orgId: org!.id,
    name: "Default",
    isDefault: true,
    createdBy: ownerId,
  });

  const client = await createClient({
    level: "space",
    name: "E2E Client",
    redirectUris: ["https://acme.example.com/oauth/callback"],
    referencedSpaceId: spaceId,
    // Signup tests exercise the happy path — opt in explicitly since
    // `allowSignup` is secure-by-default `false` on every level.
    allowSignup: true,
  });

  if (opts.smtp) {
    await upsertSmtpConfig(spaceId, {
      host: "__test_json__",
      port: 587,
      username: "u",
      pass: "p",
      fromAddress: `no-reply@${spaceId}.test`,
      fromName: "Tenant",
    });
  }

  return { spaceId, clientId: client.clientId };
}

async function getCsrf(res: Response): Promise<{ csrfToken: string; cookie: string }> {
  const cookieHeader = res.headers.get("set-cookie") ?? "";
  const cookie = cookieHeader.split(";")[0]!;
  const html = await res.text();
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  return { csrfToken: match?.[1] ?? "", cookie };
}

describe("OIDC per-space SMTP — E2E matrix (space-level clients)", () => {
  enableSmtpForSuite();

  let mails: SpiedSmtpSend[] = [];

  beforeEach(async () => {
    await truncateAll();
    _resetClientCache();
    _clearSmtpCacheForTesting();
    mails = [];
    _setSmtpSpy((m) => mails.push(m));
  });

  afterEach(() => {
    _setSmtpSpy(null);
  });

  // ─── Signup ────────────────────────────────────────────────────────────────

  it("signup (no per-space SMTP, instance SMTP on): renders interstitial, leaves user UNVERIFIED, sends zero per-space mail", async () => {
    // SECURITY (identity squat): a space-level client with no per-space SMTP must
    // NOT be auto-verified. Instance SMTP is on for this suite, so Better
    // Auth's `requireEmailVerification` withholds the session AND its
    // `sendOnSignUp` dispatches a verification email via the instance
    // transport. We surface the "check your email" interstitial and leave
    // `emailVerified=false` — only the delivered-and-confirmed link may flip
    // it. (Previously this path force-set `emailVerified=true` with zero
    // possession proof, letting an attacker squat any identity.)
    const { clientId } = await setupSpaceClient({ smtp: false });
    const qs = `?client_id=${encodeURIComponent(clientId)}&state=s`;
    const getRes = await app.request(`/api/oauth/register${qs}`);
    const { csrfToken, cookie } = await getCsrf(getRes);

    const email = `signup-noapp-${Date.now()}@test.com`;
    const res = await app.request(`/api/oauth/register${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: `_csrf=${csrfToken}&name=X&email=${encodeURIComponent(email)}&password=TestPassword123!`,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Vérifiez votre email");

    const [row] = await db
      .select({ emailVerified: userTable.emailVerified })
      .from(userTable)
      .where(eq(userTable.email, email))
      .limit(1);
    // Must stay false — no possession proof was ever provided.
    expect(row?.emailVerified).toBe(false);
    // No PER-SPACE mail leaves (there is no per-space transport). BA's own
    // instance-transport verification email is not routed through the per-space
    // resolver, so the per-space spy legitimately observes zero sends.
    expect(mails.length).toBe(0);
  });

  it("signup (with per-space SMTP): renders interstitial, leaves user unverified, sends one per-space mail", async () => {
    const { clientId } = await setupSpaceClient({ smtp: true });
    const qs = `?client_id=${encodeURIComponent(clientId)}&state=s`;
    const getRes = await app.request(`/api/oauth/register${qs}`);
    const { csrfToken, cookie } = await getCsrf(getRes);

    const email = `signup-app-${Date.now()}@test.com`;
    const res = await app.request(`/api/oauth/register${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: `_csrf=${csrfToken}&name=X&email=${encodeURIComponent(email)}&password=TestPassword123!`,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Vérifiez votre email");

    const [row] = await db
      .select({ emailVerified: userTable.emailVerified })
      .from(userTable)
      .where(eq(userTable.email, email))
      .limit(1);
    expect(row?.emailVerified).toBe(false);

    expect(mails.length).toBe(1);
    expect(mails[0]!.source).toBe("per-space");
    expect(mails[0]!.to).toContain(email);
  });

  // ─── Magic-link ────────────────────────────────────────────────────────────

  it("magic-link (no per-space SMTP): 404", async () => {
    const { clientId } = await setupSpaceClient({ smtp: false });
    const qs = `?client_id=${encodeURIComponent(clientId)}&state=s`;
    const getRes = await app.request(`/api/oauth/magic-link${qs}`);
    expect(getRes.status).toBe(404);
    expect(mails.length).toBe(0);
  });

  it("magic-link (with per-space SMTP): 200 + one per-space mail", async () => {
    const { clientId } = await setupSpaceClient({ smtp: true });

    // Magic-link returns 200 HTML "check your email" regardless of whether the
    // account exists (anti-enumeration) — a mail only goes out for a known
    // account. Seed one first, otherwise `mails` stays empty and the
    // per-space-transport assertion below iterates zero times (it used to,
    // which made this test unable to fail).
    const email = `ml-${Date.now()}@test.com`;
    await getAuth().api.signUpEmail({
      body: { email, password: "TestPassword123!", name: "ML" },
      asResponse: true,
    });
    await db.update(userTable).set({ emailVerified: true }).where(eq(userTable.email, email));
    // Signup above used the BA core path (outside OIDC routes), so it went
    // through BA's boot-time env transport and is NOT captured by the spy.
    mails.length = 0;

    const qs = `?client_id=${encodeURIComponent(clientId)}&state=s`;
    const getRes = await app.request(`/api/oauth/magic-link${qs}`);
    const { csrfToken, cookie } = await getCsrf(getRes);

    const res = await app.request(`/api/oauth/magic-link${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: `_csrf=${csrfToken}&email=${encodeURIComponent(email)}`,
    });
    expect(res.status).toBe(200);
    // Exactly the magic-link mail, and it left through the per-space
    // transport — nothing leaks through the instance transport.
    expect(mails.length).toBeGreaterThanOrEqual(1);
    for (const m of mails) expect(m.source).toBe("per-space");
  });

  // ─── Forgot password ───────────────────────────────────────────────────────

  it("forgot-password (no per-space SMTP): 404", async () => {
    const { clientId } = await setupSpaceClient({ smtp: false });
    const qs = `?client_id=${encodeURIComponent(clientId)}&state=s`;
    const getRes = await app.request(`/api/oauth/forgot-password${qs}`);
    expect(getRes.status).toBe(404);
    expect(mails.length).toBe(0);
  });

  it("forgot-password (with per-space SMTP): 200 + per-space mail for existing user", async () => {
    const { clientId } = await setupSpaceClient({ smtp: true });

    // Create a verified user so BA will actually send the reset mail.
    const email = `reset-${Date.now()}@test.com`;
    await getAuth().api.signUpEmail({
      body: { email, password: "TestPassword123!", name: "R" },
      asResponse: true,
    });
    await db.update(userTable).set({ emailVerified: true }).where(eq(userTable.email, email));
    // Signup above used the BA core path (outside OIDC routes), so it went
    // through BA's boot-time env transport and is NOT captured by the spy.
    // The subsequent forgot-password runs through OIDC routes → per-space.

    const qs = `?client_id=${encodeURIComponent(clientId)}&state=s`;
    const getRes = await app.request(`/api/oauth/forgot-password${qs}`);
    const { csrfToken, cookie } = await getCsrf(getRes);

    const res = await app.request(`/api/oauth/forgot-password${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: `_csrf=${csrfToken}&email=${encodeURIComponent(email)}`,
    });
    expect(res.status).toBe(200);
    // At least one mail, all through the per-space transport.
    expect(mails.length).toBeGreaterThanOrEqual(1);
    for (const m of mails) expect(m.source).toBe("per-space");
  });
});
