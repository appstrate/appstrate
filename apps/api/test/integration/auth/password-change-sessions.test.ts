// SPDX-License-Identifier: Apache-2.0

/**
 * Changing or resetting a password ends the account's other sessions, on the
 * platform alone (no OIDC module). The OAuth and CLI tokens revoked by the
 * same step need that module, and are covered by
 * `apps/api/src/modules/oidc/test/integration/services/password-change-revocation.test.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { createTestUser } from "../../helpers/auth.ts";
import { truncateAll } from "../../helpers/db.ts";
import { enableSmtpForSuite, captureMails, firstLink } from "../../helpers/smtp.ts";

const app = getTestApp({ modules: [] });

const PASSWORD = "TestPassword123!";
const NEW_PASSWORD = "BrandNewPassword456!";

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

async function twoBrowsers(): Promise<{ email: string; a: string; b: string }> {
  const user = await createTestUser({ emailVerified: true, password: PASSWORD });
  const b = await signIn(user.email);
  expect(await profileStatus(user.cookie)).toBe(200);
  expect(await profileStatus(b)).toBe(200);
  return { email: user.email, a: user.cookie, b };
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

describe("password reset (SMTP on)", () => {
  enableSmtpForSuite();

  beforeEach(async () => {
    await truncateAll();
  });

  it("ends every session of the account", async () => {
    const { email, a, b } = await twoBrowsers();
    const [mail] = await captureMails(async () => {
      const res = await postAuth("/request-password-reset", {
        email,
        redirectTo: "/reset-password",
      });
      expect(res.status).toBe(200);
    });
    const token = firstLink(mail!).pathname.split("/").pop()!;

    const res = await postAuth("/reset-password", { token, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(await profileStatus(a)).toBe(401);
    expect(await profileStatus(b)).toBe(401);
    // The new password signs in; the old sessions are not coming back.
    const signedIn = await postAuth("/sign-in/email", { email, password: NEW_PASSWORD });
    expect(signedIn.status).toBe(200);
  });
});
