// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * The Microsoft callback against an organization's settings: tenant binding,
 * auto-join, linking an existing account, the 24 h cap without slide.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { account, organizationMembers, session, user } from "@appstrate/db/schema";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { db, truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { getEeDb } from "../../src/db.ts";
import { ssoSessions } from "../../drizzle/schema.ts";
import { ENFORCED_SESSION_MAX_AGE_MS } from "../../src/sso/policy.ts";
import {
  DOMAIN,
  OTHER_TENANT,
  TENANT,
  interceptProviderFetches,
  microsoftSignIn,
  redirectError,
  seedSso,
  sessionCookieFrom,
  withSocialProviders,
} from "../helpers/sso.ts";

const app = getTestApp();
withSocialProviders();
interceptProviderFetches();

async function sessionsOf(userId: string) {
  return db.select().from(session).where(eq(session.userId, userId));
}

async function roleIn(orgId: string, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  return row?.role ?? null;
}

describe("Microsoft sign-in for an address of a bound domain", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  it("opens a session for an address of no organization's domain, untouched", async () => {
    const res = await microsoftSignIn(app, {
      email: "someone@elsewhere.test",
      tenantId: OTHER_TENANT,
    });
    expect(sessionCookieFrom(res)).not.toBeNull();
  });

  it("auto-joins a newcomer with the organization's role, records the session's tenant", async () => {
    await seedSso({ orgId: ctx.orgId, joinRole: "guest" });
    const res = await microsoftSignIn(app, { email: `new@${DOMAIN}`, tenantId: TENANT });
    expect(sessionCookieFrom(res)).not.toBeNull();
    const [created] = await db
      .select()
      .from(user)
      .where(eq(user.email, `new@${DOMAIN}`));
    expect(await roleIn(ctx.orgId, created!.id)).toBe("guest");
    const [sess] = await sessionsOf(created!.id);
    const [record] = await getEeDb()
      .select()
      .from(ssoSessions)
      .where(eq(ssoSessions.sessionId, sess!.id));
    expect(record?.tenantId).toBe(TENANT);
  });

  it("auto-joins as member by default and leaves an existing member's role alone", async () => {
    await seedSso({ orgId: ctx.orgId });
    await microsoftSignIn(app, { email: `first@${DOMAIN}`, tenantId: TENANT });
    const [first] = await db
      .select()
      .from(user)
      .where(eq(user.email, `first@${DOMAIN}`));
    expect(await roleIn(ctx.orgId, first!.id)).toBe("member");

    const admin = await createTestUser({ email: `admin@${DOMAIN}`, emailVerified: true });
    await addOrgMember(ctx.orgId, admin.id, "admin");
    await microsoftSignIn(app, { email: `admin@${DOMAIN}`, tenantId: TENANT });
    expect(await roleIn(ctx.orgId, admin.id)).toBe("admin");
  });

  it("links an existing password account instead of creating a second one", async () => {
    await seedSso({ orgId: ctx.orgId });
    const existing = await createTestUser({ email: `alice@${DOMAIN}`, emailVerified: true });
    const res = await microsoftSignIn(app, { email: `alice@${DOMAIN}`, tenantId: TENANT });
    expect(sessionCookieFrom(res)).not.toBeNull();
    expect(
      await db
        .select()
        .from(user)
        .where(eq(user.email, `alice@${DOMAIN}`)),
    ).toHaveLength(1);
    const providers = (await db.select().from(account).where(eq(account.userId, existing.id))).map(
      (a) => a.providerId,
    );
    expect(providers.sort()).toEqual(["credential", "microsoft"]);
  });

  for (const enforced of [false, true]) {
    it(`refuses another tenant for the domain (${enforced ? "enforced" : "linked"})`, async () => {
      await seedSso({ orgId: ctx.orgId, enforced });
      const res = await microsoftSignIn(app, { email: `eve@${DOMAIN}`, tenantId: OTHER_TENANT });
      expect(sessionCookieFrom(res)).toBeNull();
      expect(redirectError(res)).toBe("sso_tenant_mismatch");
      // Refused before the identity was linked: Better Auth's drizzle adapter runs no
      // transaction, so the bare user row it wrote first stays — with no sign-in
      // method, no session and no membership.
      const [eve] = await db
        .select()
        .from(user)
        .where(eq(user.email, `eve@${DOMAIN}`));
      if (eve) {
        expect(await db.select().from(account).where(eq(account.userId, eve.id))).toHaveLength(0);
        expect(await sessionsOf(eve.id)).toHaveLength(0);
        expect(await roleIn(ctx.orgId, eve.id)).toBeNull();
      }
    });
  }

  it("refuses another tenant on an existing linked account too", async () => {
    await seedSso({ orgId: ctx.orgId });
    await microsoftSignIn(app, { email: `bob@${DOMAIN}`, tenantId: TENANT, oid: "oid-bob" });
    const res = await microsoftSignIn(app, {
      email: `bob@${DOMAIN}`,
      tenantId: OTHER_TENANT,
      oid: "oid-bob",
    });
    expect(redirectError(res)).toBe("sso_tenant_mismatch");
    expect(sessionCookieFrom(res)).toBeNull();
  });

  it("does not let a tenant member's identity, linked to someone else's account, open it or join for it", async () => {
    await seedSso({ orgId: ctx.orgId });
    const ceo = await createTestUser({ email: `ceo@${DOMAIN}`, emailVerified: true });
    const mallory = { email: `mallory@${DOMAIN}`, tenantId: TENANT, oid: "oid-mallory" };
    // Mallory, signed in to the CEO's password account, links her own Microsoft identity to it.
    const linked = await microsoftSignIn(app, mallory, ceo.cookie);
    expect(redirectError(linked)).toBeNull();
    expect(
      (await db.select().from(account).where(eq(account.userId, ceo.id))).map((a) => a.providerId),
    ).toContain("microsoft");
    await db.delete(session).where(eq(session.userId, ceo.id));

    const res = await microsoftSignIn(app, mallory);
    expect(sessionCookieFrom(res)).toBeNull();
    expect(redirectError(res)).toBe("sso_tenant_mismatch");
    expect(await sessionsOf(ceo.id)).toHaveLength(0);
    expect(await roleIn(ctx.orgId, ceo.id)).toBeNull();
  });

  it("caps an enforced session at 24 h from creation", async () => {
    await seedSso({ orgId: ctx.orgId, enforced: true });
    const before = Date.now();
    await microsoftSignIn(app, { email: `carol@${DOMAIN}`, tenantId: TENANT });
    const [carol] = await db
      .select()
      .from(user)
      .where(eq(user.email, `carol@${DOMAIN}`));
    const [sess] = await sessionsOf(carol!.id);
    expect(sess!.expiresAt.getTime()).toBeLessThanOrEqual(
      before + ENFORCED_SESSION_MAX_AGE_MS + 5_000,
    );
    expect(sess!.expiresAt.getTime()).toBeGreaterThan(
      before + ENFORCED_SESSION_MAX_AGE_MS - 60_000,
    );
  });

  it("does not slide an enforced session when Better Auth refreshes it", async () => {
    await seedSso({ orgId: ctx.orgId, enforced: true });
    const res = await microsoftSignIn(app, { email: `dan@${DOMAIN}`, tenantId: TENANT });
    const cookie = sessionCookieFrom(res)!;
    const [dan] = await db
      .select()
      .from(user)
      .where(eq(user.email, `dan@${DOMAIN}`));
    // 20 h old, and due for a refresh by Better Auth's own rule.
    const createdAt = new Date(Date.now() - 20 * 60 * 60 * 1000);
    await db
      .update(session)
      .set({ createdAt, updatedAt: createdAt, expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(session.userId, dan!.id));
    const profile = await app.request("/api/profile", { headers: { Cookie: cookie } });
    expect(profile.status).toBe(200);
    const [after] = await sessionsOf(dan!.id);
    expect(after!.expiresAt.getTime()).toBeLessThanOrEqual(
      createdAt.getTime() + ENFORCED_SESSION_MAX_AGE_MS,
    );
  });

  it("still slides a session outside an enforced domain (control)", async () => {
    const res = await microsoftSignIn(app, {
      email: "erin@elsewhere.test",
      tenantId: OTHER_TENANT,
    });
    const cookie = sessionCookieFrom(res)!;
    const [erin] = await db.select().from(user).where(eq(user.email, "erin@elsewhere.test"));
    const createdAt = new Date(Date.now() - 20 * 60 * 60 * 1000);
    await db
      .update(session)
      .set({ createdAt, updatedAt: createdAt, expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(session.userId, erin!.id));
    await app.request("/api/profile", { headers: { Cookie: cookie } });
    const [after] = await sessionsOf(erin!.id);
    expect(after!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
  });
});
