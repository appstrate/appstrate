// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Every way Better Auth opens a session, against an address of an enforced
 * domain. Only the Microsoft callback of the bound tenant and an owner's
 * emergency password sign-in get through.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { createEmailVerificationToken } from "better-auth/api";
import { deviceCode, session, user } from "@appstrate/db/schema";
import { getAuth, setBeforeSignupHook, _authHookSlotsForTesting } from "@appstrate/db/auth";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { db, truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  addOrgMember,
  authClientFor,
  captureIssuedMagicLinks,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { enableSmtpForSuite } from "../../../apps/api/test/helpers/smtp.ts";
import { callAllHooks } from "../../../apps/api/src/lib/modules/module-loader.ts";
import { ENFORCED_SESSION_MAX_AGE_MS } from "../../src/sso/policy.ts";
import {
  DOMAIN,
  TENANT,
  githubSignIn,
  interceptProviderFetches,
  microsoftSignIn,
  redirectError,
  seedSso,
  sessionCookieFrom,
  withSocialProviders,
} from "../helpers/sso.ts";

const app = getTestApp();
const client = authClientFor(app);
const PASSWORD = "TestPassword123!";
withSocialProviders();
interceptProviderFetches();

// Production wires module signup hooks at boot; the harness does not.
let previousSignupHook: ReturnType<typeof _authHookSlotsForTesting.beforeSignup.get> = null;
beforeAll(() => {
  previousSignupHook = _authHookSlotsForTesting.beforeSignup.swapForTesting(null);
  setBeforeSignupHook((email, ctx) => callAllHooks("beforeSignup", email, ctx));
});
afterAll(() => {
  _authHookSlotsForTesting.beforeSignup.swapForTesting(previousSignupHook);
});

async function signInEmail(email: string, password: string, emergency = false) {
  const res = await app.request(`/api/auth/sign-in/email${emergency ? "?emergency=1" : ""}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return {
    status: res.status,
    body: (await res.json()) as { code?: string; message?: string },
    res,
  };
}

async function sessionCount(userId: string): Promise<number> {
  return (await db.select().from(session).where(eq(session.userId, userId))).length;
}

describe("an enforced domain", () => {
  let ctx: TestContext;
  let alice: Awaited<ReturnType<typeof createTestUser>>;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    await seedSso({ orgId: ctx.orgId, enforced: true });
    alice = await createTestUser({ email: `alice@${DOMAIN}`, emailVerified: true });
    await addOrgMember(ctx.orgId, alice.id, "member");
    await db.delete(session).where(eq(session.userId, alice.id));
  });

  describe("password sign-in", () => {
    it("is refused before the password is checked: right and wrong get the same answer", async () => {
      const right = await signInEmail(alice.email, PASSWORD);
      const wrong = await signInEmail(alice.email, "not-the-password");
      expect(right.status).toBe(403);
      expect(right.body.code).toBe("sso_required");
      expect(wrong).toMatchObject({ status: right.status, body: right.body });
      expect(await sessionCount(alice.id)).toBe(0);
    });

    it("answers an address without an account the same way", async () => {
      const absent = await signInEmail(`nobody@${DOMAIN}`, PASSWORD);
      expect(absent.status).toBe(403);
      expect(absent.body.code).toBe("sso_required");
    });

    it("works again once enforcement is lifted (nothing was deleted)", async () => {
      await truncateAll();
      ctx = await createTestContext();
      await seedSso({ orgId: ctx.orgId, enforced: false });
      alice = await createTestUser({ email: `alice@${DOMAIN}`, emailVerified: true });
      expect((await signInEmail(alice.email, PASSWORD)).status).toBe(200);
    });
  });

  describe("emergency sign-in", () => {
    let owner: Awaited<ReturnType<typeof createTestUser>>;

    beforeEach(async () => {
      owner = await createTestUser({ email: `owner@${DOMAIN}`, emailVerified: true });
      await addOrgMember(ctx.orgId, owner.id, "owner");
      await db.delete(session).where(eq(session.userId, owner.id));
    });

    it("lets an owner of the enforcing organization in, for 24 h at most", async () => {
      const before = Date.now();
      const res = await signInEmail(owner.email, PASSWORD, true);
      expect(res.status).toBe(200);
      const [sess] = await db.select().from(session).where(eq(session.userId, owner.id));
      expect(sess!.expiresAt.getTime()).toBeLessThanOrEqual(
        before + ENFORCED_SESSION_MAX_AGE_MS + 5_000,
      );
    });

    it("refuses an owner's wrong password", async () => {
      const res = await signInEmail(owner.email, "wrong-password", true);
      expect(res.status).toBe(401);
      expect(await sessionCount(owner.id)).toBe(0);
    });

    it("gives a non-owner the wrong-password answer whether or not the password is right", async () => {
      const right = await signInEmail(alice.email, PASSWORD, true);
      const wrong = await signInEmail(alice.email, "wrong-password", true);
      const ownerWrong = await signInEmail(owner.email, "wrong-password", true);
      expect(right.status).toBe(401);
      expect(right.body).toEqual(wrong.body);
      expect(right.body).toEqual(ownerWrong.body);
      expect(await sessionCount(alice.id)).toBe(0);
    });

    it("does not let an owner of ANOTHER organization in", async () => {
      const other = await createTestContext();
      await addOrgMember(other.orgId, alice.id, "owner");
      expect((await signInEmail(alice.email, PASSWORD, true)).status).toBe(401);
    });

    it("keeps a replaced session's deadline when the owner changes the password", async () => {
      const signedIn = await signInEmail(owner.email, PASSWORD, true);
      const cookie = /better-auth\.session_token=([^;]+)/.exec(
        signedIn.res.headers.get("set-cookie") ?? "",
      )![1]!;
      const createdAt = new Date(Date.now() - 23 * 60 * 60 * 1000);
      await db.update(session).set({ createdAt }).where(eq(session.userId, owner.id));
      const res = await client.post(
        "/change-password",
        {
          currentPassword: PASSWORD,
          newPassword: "AnotherPassword123!",
          revokeOtherSessions: true,
        },
        `better-auth.session_token=${cookie}`,
      );
      expect(res.status).toBe(200);
      const [sess] = await db.select().from(session).where(eq(session.userId, owner.id));
      expect(sess!.expiresAt.getTime()).toBeLessThanOrEqual(
        createdAt.getTime() + ENFORCED_SESSION_MAX_AGE_MS,
      );
    });
  });

  it("refuses a password sign-up at the domain", async () => {
    const res = await client.post("/sign-up/email", {
      email: `newcomer@${DOMAIN}`,
      password: PASSWORD,
      name: "Newcomer",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("sso_required");
    expect(
      await db
        .select()
        .from(user)
        .where(eq(user.email, `newcomer@${DOMAIN}`)),
    ).toHaveLength(0);
  });

  it("refuses a GitHub sign-in for the address", async () => {
    const res = await githubSignIn(app, alice.email);
    expect(sessionCookieFrom(res)).toBeNull();
    expect(redirectError(res)).toBe("sso_required");
    expect(await sessionCount(alice.id)).toBe(0);
  });

  it("opens a session for the Microsoft callback of the bound tenant", async () => {
    const res = await microsoftSignIn(app, { email: alice.email, tenantId: TENANT });
    expect(sessionCookieFrom(res)).not.toBeNull();
    expect(await sessionCount(alice.id)).toBe(1);
  });

  it("refuses an email-change link that moves an account onto the domain", async () => {
    const outsider = await createTestUser({
      email: "outsider@elsewhere.test",
      emailVerified: true,
    });
    const token = await createEmailVerificationToken(
      (await getAuth().$context).secret,
      outsider.email,
      `outsider@${DOMAIN}`,
      undefined,
      { requestType: "change-email-verification" },
    );
    await app.request(
      `/api/auth/verify-email?token=${token}&callbackURL=${encodeURIComponent("/welcome")}`,
      { headers: { Cookie: outsider.cookie } },
    );
    const [row] = await db.select().from(user).where(eq(user.id, outsider.id));
    expect(row!.email).toBe("outsider@elsewhere.test");
  });

  it("refuses the device flow's own session (`/device/token`)", async () => {
    const { ensureCliClient } =
      await import("../../../apps/api/src/modules/oidc/services/ensure-cli-client.ts");
    await ensureCliClient();
    const cookie = sessionCookieFrom(
      await microsoftSignIn(app, { email: alice.email, tenantId: TENANT }),
    )!;
    const codeRes = await client.post("/device/code", {
      client_id: "appstrate-cli",
      scope: "openid profile email",
    });
    expect(codeRes.status).toBe(200);
    const code = (await codeRes.json()) as { device_code: string; user_code: string };
    await app.request(`/api/auth/device?user_code=${encodeURIComponent(code.user_code)}`, {
      headers: { Cookie: cookie },
    });
    expect(
      (await client.post("/device/approve", { userCode: code.user_code }, cookie)).status,
    ).toBe(200);
    await db
      .update(deviceCode)
      .set({ lastPolledAt: new Date(Date.now() - 10_000) })
      .where(eq(deviceCode.deviceCode, code.device_code));
    const res = await client.post("/device/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: code.device_code,
      client_id: "appstrate-cli",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("sso_required");
    expect(await sessionCount(alice.id)).toBe(1);
  });

  it("refuses to move an enforced account to another address", async () => {
    const signedIn = await microsoftSignIn(app, { email: alice.email, tenantId: TENANT });
    const res = await client.post(
      "/change-email",
      { newEmail: "alice@elsewhere.test" },
      sessionCookieFrom(signedIn)!,
    );
    expect(res.status).toBe(403);
    const [row] = await db.select().from(user).where(eq(user.id, alice.id));
    expect(row!.email).toBe(alice.email);
  });

  it("leaves an end-user account of an application at the same domain alone", async () => {
    const endUser = await createTestUser({ email: `client@${DOMAIN}`, emailVerified: true });
    await db.update(user).set({ realm: "end_user:spc_test" }).where(eq(user.id, endUser.id));
    const res = await signInEmail(endUser.email, PASSWORD);
    expect(res.status).toBe(200);
  });
});

describe("an enforced domain, mail on", () => {
  // Magic links need a transport; the helper rebuilds auth with one.
  enableSmtpForSuite();
  const links = captureIssuedMagicLinks();
  let alice: Awaited<ReturnType<typeof createTestUser>>;

  beforeEach(async () => {
    await truncateAll();
    const ctx = await createTestContext();
    await seedSso({ orgId: ctx.orgId, enforced: true });
    alice = await createTestUser({ email: `alice@${DOMAIN}`, emailVerified: true });
    await db.delete(session).where(eq(session.userId, alice.id));
  });

  it("refuses to create an account at the domain through a magic link", async () => {
    const email = `fresh@${DOMAIN}`;
    expect(
      (
        await client.post("/sign-in/magic-link", {
          email,
          callbackURL: "/",
          errorCallbackURL: "/login",
        })
      ).status,
    ).toBe(200);
    const res = await app.request(
      `/api/auth/magic-link/verify?token=${links.tokenFor(email)}&callbackURL=%2F&errorCallbackURL=%2Flogin`,
    );
    expect(redirectError(res)).toBe("sso_required");
    expect(await db.select().from(user).where(eq(user.email, email))).toHaveLength(0);
  });

  it("refuses the magic link at its verification, with a redirect naming the reason", async () => {
    const send = await client.post("/sign-in/magic-link", {
      email: alice.email,
      callbackURL: "/",
      errorCallbackURL: "/login",
    });
    expect(send.status).toBe(200);
    const res = await app.request(
      `/api/auth/magic-link/verify?token=${links.tokenFor(alice.email)}&callbackURL=%2F&errorCallbackURL=%2Flogin`,
    );
    expect(redirectError(res)).toBe("sso_required");
    expect(await sessionCount(alice.id)).toBe(0);
  });

  it("refuses the email-verification auto sign-in", async () => {
    const pending = await createTestUser({ email: `pending@${DOMAIN}` });
    await db.delete(session).where(eq(session.userId, pending.id));
    const token = await createEmailVerificationToken(
      (await getAuth().$context).secret,
      pending.email,
    );
    const res = await app.request(
      `/api/auth/verify-email?token=${token}&callbackURL=${encodeURIComponent("/welcome")}`,
    );
    expect(res.status).toBe(302);
    expect(redirectError(res)).toBe("sso_required");
    expect(await sessionCount(pending.id)).toBe(0);
  });
});
