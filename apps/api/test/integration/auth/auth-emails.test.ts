// SPDX-License-Identifier: Apache-2.0

/**
 * The e-mails Better Auth sends for the platform's own (non-OIDC) auth flows,
 * read off the wire: which address each goes to, where its link points, and
 * that the link does what the message says.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { _swapMagicLinkIssuedHookForTesting } from "@appstrate/db/auth";
import { getTestApp } from "../../helpers/app.ts";
import { createTestUser } from "../../helpers/auth.ts";
import { truncateAll } from "../../helpers/db.ts";
import { enableSmtpForSuite, captureMails, firstLink } from "../../helpers/smtp.ts";

// Core only: no OIDC routes, as on an instance whose `MODULES` omits `oidc`.
const app = getTestApp({ modules: [] });

const PASSWORD = "TestPassword123!";

async function sessionEmail(cookie: string): Promise<string | undefined> {
  const res = await app.request("/api/auth/get-session", { headers: { Cookie: cookie } });
  const body = (await res.json()) as { user?: { email?: string } } | null;
  return body?.user?.email;
}

function postAuth(path: string, body: unknown, cookie?: string): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/auth${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    }),
  );
}

describe("platform auth e-mails (SMTP on)", () => {
  enableSmtpForSuite();

  beforeEach(async () => {
    await truncateAll();
  });

  describe("magic link without the OIDC module", () => {
    it("emails a link that signs the recipient in", async () => {
      const oidcHook = _swapMagicLinkIssuedHookForTesting(null);
      try {
        const email = `magic-${crypto.randomUUID()}@example.test`;
        const mails = await captureMails(async () => {
          const res = await postAuth("/sign-in/magic-link", { email, callbackURL: "/" });
          expect(res.status).toBe(200);
        });

        expect(mails).toHaveLength(1);
        expect(mails[0]!.to).toBe(email);
        const link = firstLink(mails[0]!);
        expect(link.pathname).toBe("/api/auth/magic-link/verify");

        const verifyRes = await app.request(`${link.pathname}${link.search}`);
        expect(verifyRes.status).toBe(302);
        expect(new URL(verifyRes.headers.get("location")!).pathname).toBe("/");
        expect(verifyRes.headers.get("set-cookie")).toContain("session_token=");
      } finally {
        _swapMagicLinkIssuedHookForTesting(oidcHook);
      }
    });
  });

  describe("sign-up", () => {
    it("puts the caller's callbackURL in the verification link, and the link signs in there", async () => {
      const email = `invitee-${crypto.randomUUID()}@example.test`;
      const mails = await captureMails(async () => {
        const res = await postAuth("/sign-up/email", {
          email,
          password: PASSWORD,
          name: "Invitee",
          callbackURL: "/invite/some-token",
        });
        expect(res.status).toBe(200);
      });

      expect(mails).toHaveLength(1);
      expect(mails[0]!.html).toContain("Ce lien expire dans 1 heure.");
      const link = firstLink(mails[0]!);
      expect(link.searchParams.get("callbackURL")).toBe("/invite/some-token");

      const verifyRes = await app.request(`${link.pathname}${link.search}`);
      expect(verifyRes.status).toBe(302);
      expect(new URL(verifyRes.headers.get("location")!, "http://x").pathname).toBe(
        "/invite/some-token",
      );
      expect(verifyRes.headers.get("set-cookie")).toContain("session_token=");
    });

    it("on a taken address, emails the account's owner instead of nobody", async () => {
      const owner = await createTestUser({ emailVerified: true });
      const mails = await captureMails(async () => {
        const res = await postAuth("/sign-up/email", {
          email: owner.email,
          password: "AnotherPassword123!",
          name: "Someone else",
        });
        // Same answer as a fresh sign-up: the caller learns nothing.
        expect(res.status).toBe(200);
      });

      expect(mails).toHaveLength(1);
      expect(mails[0]!.to).toBe(owner.email);
      expect(mails[0]!.subject).toBe("Vous avez déjà un compte");
    });
  });

  describe("email change", () => {
    it("asks the current address first, then verifies the new one", async () => {
      const account = await createTestUser({ emailVerified: true });
      const newEmail = `new-${crypto.randomUUID()}@example.test`;

      const toCurrent = await captureMails(async () => {
        const res = await postAuth("/change-email", { newEmail }, account.cookie);
        expect(res.status).toBe(200);
      });
      expect(toCurrent).toHaveLength(1);
      expect(toCurrent[0]!.to).toBe(account.email);
      expect(toCurrent[0]!.subject).toBe("Confirmez le changement de votre adresse email");
      expect(toCurrent[0]!.html).toContain(newEmail);
      expect(await sessionEmail(account.cookie)).toBe(account.email);

      const approve = firstLink(toCurrent[0]!);
      const toNew = await captureMails(async () => {
        const res = await app.request(`${approve.pathname}${approve.search}`, {
          headers: { Cookie: account.cookie },
        });
        expect(res.status).toBe(302);
      });
      expect(toNew).toHaveLength(1);
      expect(toNew[0]!.to).toBe(newEmail);
      // Nothing moves until the new address proves itself.
      expect(await sessionEmail(account.cookie)).toBe(account.email);

      const verify = firstLink(toNew[0]!);
      const verifyRes = await app.request(`${verify.pathname}${verify.search}`, {
        headers: { Cookie: account.cookie },
      });
      expect(verifyRes.status).toBe(302);
      expect(await sessionEmail(account.cookie)).toBe(newEmail);
    });
  });

  describe("password change", () => {
    it("notifies the account after a change from the settings", async () => {
      const account = await createTestUser({ emailVerified: true, password: PASSWORD });
      const mails = await captureMails(async () => {
        const res = await postAuth(
          "/change-password",
          { currentPassword: PASSWORD, newPassword: "BrandNewPassword456!" },
          account.cookie,
        );
        expect(res.status).toBe(200);
      });

      expect(mails).toHaveLength(1);
      expect(mails[0]!.to).toBe(account.email);
      expect(mails[0]!.subject).toBe("Votre mot de passe a été modifié");
    });

    it("sends nothing when the change is refused", async () => {
      const account = await createTestUser({ emailVerified: true, password: PASSWORD });
      const mails = await captureMails(async () => {
        const res = await postAuth(
          "/change-password",
          { currentPassword: "WrongPassword000!", newPassword: "BrandNewPassword456!" },
          account.cookie,
        );
        expect(res.status).toBe(400);
      });

      expect(mails).toHaveLength(0);
    });

    it("notifies the account after a reset by email", async () => {
      const account = await createTestUser({ emailVerified: true, password: PASSWORD });
      const resetMails = await captureMails(async () => {
        const res = await postAuth("/request-password-reset", {
          email: account.email,
          redirectTo: "/reset-password",
        });
        expect(res.status).toBe(200);
      });
      expect(resetMails).toHaveLength(1);
      expect(resetMails[0]!.html).toContain("Ce lien expire dans 1 heure.");
      const token = firstLink(resetMails[0]!).pathname.split("/").pop()!;

      const mails = await captureMails(async () => {
        const res = await postAuth("/reset-password", {
          token,
          newPassword: "BrandNewPassword456!",
        });
        expect(res.status).toBe(200);
      });

      expect(mails).toHaveLength(1);
      expect(mails[0]!.to).toBe(account.email);
      expect(mails[0]!.subject).toBe("Votre mot de passe a été modifié");
    });
  });
});

describe("email change without SMTP", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  // The contract the settings form relies on: Better Auth does not say that
  // an address is taken, so the form reads the session to learn the outcome.
  it("answers 200 for a taken address and leaves the session's email unchanged", async () => {
    const taken = await createTestUser();
    const account = await createTestUser();

    const res = await postAuth("/change-email", { newEmail: taken.email }, account.cookie);

    expect(res.status).toBe(200);
    expect(await sessionEmail(account.cookie)).toBe(account.email);
  });

  it("changes the address at once when it is free", async () => {
    const account = await createTestUser();
    const newEmail = `free-${crypto.randomUUID()}@example.test`;

    const res = await postAuth("/change-email", { newEmail }, account.cookie);

    expect(res.status).toBe(200);
    expect(await sessionEmail(account.cookie)).toBe(newEmail);
  });
});
