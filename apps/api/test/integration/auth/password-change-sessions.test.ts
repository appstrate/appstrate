// SPDX-License-Identifier: Apache-2.0

/**
 * Core's half of a password change or reset, with the OIDC module's hook taken
 * out: the account's other sessions end, and its stored reset links, magic
 * links and social-link states stop working.
 * The OAuth tokens, CLI sessions and device codes the OIDC module revokes are
 * covered by
 * `apps/api/src/modules/oidc/test/integration/services/password-change-revocation.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { eq, like } from "drizzle-orm";
import { _swapMagicLinkIssuedHookForTesting } from "@appstrate/db/auth";
import { _swapCredentialChangeHookForTesting } from "@appstrate/db/credential-change";
import { session as sessionTable, verification } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { createTestUser, SESSION_TTL_MS } from "../../helpers/auth.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { enableSmtpForSuite, captureMails, firstLink } from "../../helpers/smtp.ts";

const app = getTestApp({ modules: [] });

const PASSWORD = "TestPassword123!";
const NEW_PASSWORD = "BrandNewPassword456!";

// Core alone, as on an instance whose `MODULES` omits `oidc`.
let oidcRevocation: ReturnType<typeof _swapCredentialChangeHookForTesting>;
beforeAll(() => {
  oidcRevocation = _swapCredentialChangeHookForTesting(null);
});
afterAll(() => {
  _swapCredentialChangeHookForTesting(oidcRevocation);
});

function postAuth(path: string, body: unknown, cookie?: string): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/auth${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    }),
  );
}

/** A second browser: a real sign-in, next to the session `createTestUser` seeds. */
async function signIn(email: string): Promise<string> {
  const res = await postAuth("/sign-in/email", { email, password: PASSWORD });
  expect(res.status).toBe(200);
  const token = /better-auth\.session_token=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
  if (!token) throw new Error("sign-in set no session cookie");
  return `better-auth.session_token=${token[1]}`;
}

async function profileStatus(cookie: string): Promise<number> {
  return (await app.request("/api/profile", { headers: { Cookie: cookie } })).status;
}

async function twoBrowsers(): Promise<{ id: string; email: string; a: string; b: string }> {
  const user = await createTestUser({ emailVerified: true, password: PASSWORD });
  const b = await signIn(user.email);
  expect(await profileStatus(user.cookie)).toBe(200);
  expect(await profileStatus(b)).toBe(200);
  return { id: user.id, email: user.email, a: user.cookie, b };
}

/** More sessions than Better Auth lists or plans hooks for in one read (100). */
async function seedSessions(userId: string, count: number): Promise<void> {
  await db.insert(sessionTable).values(
    Array.from({ length: count }, () => ({
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    })),
  );
}

async function sessionCount(userId: string): Promise<number> {
  return (await db.select().from(sessionTable).where(eq(sessionTable.userId, userId))).length;
}

describe("password change without SMTP", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("ends the other session and keeps the one that made the change", async () => {
    const { a, b } = await twoBrowsers();

    const res = await postAuth(
      "/change-password",
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      a,
    );

    expect(res.status).toBe(200);
    expect(await profileStatus(a)).toBe(200);
    expect(await profileStatus(b)).toBe(401);
  });

  it("ends every other session, however many there are", async () => {
    const { id, a } = await twoBrowsers();
    await seedSessions(id, 120);

    const res = await postAuth(
      "/change-password",
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      a,
    );

    expect(res.status).toBe(200);
    expect(await sessionCount(id)).toBe(1);
    expect(await profileStatus(a)).toBe(200);
  });

  it("drops the account's social-link states, and only those", async () => {
    const { id, email, a } = await twoBrowsers();
    const linkState = (userId: string) =>
      JSON.stringify({ callbackURL: "/", codeVerifier: "v", link: { email, userId } });
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await db.insert(verification).values([
      { id: crypto.randomUUID(), identifier: "auth-state:own", value: linkState(id), expiresAt },
      {
        id: crypto.randomUUID(),
        identifier: "auth-state:other",
        value: linkState("someone-else"),
        expiresAt,
      },
      { id: crypto.randomUUID(), identifier: "auth-state:raw", value: "not json", expiresAt },
    ]);

    const res = await postAuth(
      "/change-password",
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      a,
    );

    expect(res.status).toBe(200);
    const left = await db
      .select({ identifier: verification.identifier })
      .from(verification)
      .where(like(verification.identifier, "auth-state:%"));
    expect(left.map((r) => r.identifier).sort()).toEqual(["auth-state:other", "auth-state:raw"]);
  });

  it("keeps the session Better Auth hands back when the caller asks it to rotate", async () => {
    const { a, b } = await twoBrowsers();

    const res = await postAuth(
      "/change-password",
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true },
      a,
    );

    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string | null };
    expect(token).toBeTruthy();
    const rotated = /better-auth\.session_token=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
    expect(rotated).not.toBeNull();
    expect(await profileStatus(`better-auth.session_token=${rotated![1]}`)).toBe(200);
    expect(await profileStatus(a)).toBe(401);
    expect(await profileStatus(b)).toBe(401);
  });

  it("ends nothing when the change is refused", async () => {
    const { a, b } = await twoBrowsers();

    const res = await postAuth(
      "/change-password",
      { currentPassword: "WrongPassword000!", newPassword: NEW_PASSWORD },
      a,
    );

    expect(res.status).toBe(400);
    expect(await profileStatus(a)).toBe(200);
    expect(await profileStatus(b)).toBe(200);
  });
});

describe("password reset links (SMTP on)", () => {
  enableSmtpForSuite();

  beforeEach(async () => {
    await truncateAll();
  });

  async function resetToken(email: string): Promise<string> {
    const [mail] = await captureMails(async () => {
      const res = await postAuth("/request-password-reset", {
        email,
        redirectTo: "/reset-password",
      });
      expect(res.status).toBe(200);
    });
    return firstLink(mail!).pathname.split("/").pop()!;
  }

  it("a reset ends every session of the account and spends the other links", async () => {
    const { id, email, a, b } = await twoBrowsers();
    await seedSessions(id, 120);
    const token = await resetToken(email);
    const other = await resetToken(email);

    const res = await postAuth("/reset-password", { token, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(await profileStatus(a)).toBe(401);
    expect(await profileStatus(b)).toBe(401);
    expect(await sessionCount(id)).toBe(0);
    const replay = await postAuth("/reset-password", { token: other, newPassword: PASSWORD });
    expect(replay.status).toBe(400);
    // The new password signs in; the old sessions are not coming back.
    const signedIn = await postAuth("/sign-in/email", { email, password: NEW_PASSWORD });
    expect(signedIn.status).toBe(200);
  });

  describe("magic links", () => {
    let oidcHook: ReturnType<typeof _swapMagicLinkIssuedHookForTesting>;
    beforeEach(() => {
      oidcHook = _swapMagicLinkIssuedHookForTesting(null);
    });
    afterEach(() => {
      _swapMagicLinkIssuedHookForTesting(oidcHook);
    });

    it("a reset spends the magic links still outstanding", async () => {
      const { email } = await twoBrowsers();
      const [mail] = await captureMails(async () => {
        const res = await postAuth("/sign-in/magic-link", {
          email,
          callbackURL: "/",
          errorCallbackURL: "/magic-link",
        });
        expect(res.status).toBe(200);
      });
      const magicLink = firstLink(mail!);

      const reset = await postAuth("/reset-password", {
        token: await resetToken(email),
        newPassword: NEW_PASSWORD,
      });

      expect(reset.status).toBe(200);
      const verify = await app.request(`/api/auth/magic-link/verify${magicLink.search}`);
      expect(verify.status).toBe(302);
      expect(new URL(verify.headers.get("location")!, "http://x").pathname).toBe("/magic-link");
      expect(verify.headers.get("set-cookie") ?? "").not.toContain("session_token=");
    });
  });

  it("a change spends the reset links still outstanding", async () => {
    const { email, a } = await twoBrowsers();
    const token = await resetToken(email);

    const res = await postAuth(
      "/change-password",
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      a,
    );

    expect(res.status).toBe(200);
    const replay = await postAuth("/reset-password", { token, newPassword: PASSWORD });
    expect(replay.status).toBe(400);
  });
});
