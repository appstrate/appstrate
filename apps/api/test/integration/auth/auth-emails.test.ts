// SPDX-License-Identifier: Apache-2.0

/**
 * The e-mails Better Auth sends for the platform's own (non-OIDC) auth flows,
 * read off the wire: which address each goes to, where its link points, and
 * that the link does what the message says.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import type { Transporter } from "nodemailer";
import { _authHookSlotsForTesting, withSmtpOverride } from "@appstrate/db/auth";
import { logger } from "@appstrate/db/logger";
import { _resetCacheForTesting } from "@appstrate/env";
import { eq } from "drizzle-orm";
import { profiles, user as userTable } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { createTestUser } from "../../helpers/auth.ts";
import { db, truncateAll } from "../../helpers/db.ts";
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

async function speaksEnglish(userId: string): Promise<void> {
  await db.update(profiles).set({ language: "en" }).where(eq(profiles.id, userId));
}

describe("platform auth e-mails (SMTP on)", () => {
  enableSmtpForSuite();

  beforeEach(async () => {
    await truncateAll();
  });

  describe("magic link without the OIDC module", () => {
    const magicLinkSlot = _authHookSlotsForTesting.magicLinkIssued;
    let oidcHook: ReturnType<typeof magicLinkSlot.get>;
    beforeEach(() => {
      oidcHook = magicLinkSlot.swapForTesting(null);
    });
    afterEach(() => {
      magicLinkSlot.swapForTesting(oidcHook);
    });

    async function requestLink(email: string): Promise<URL> {
      const mails = await captureMails(async () => {
        const res = await postAuth("/sign-in/magic-link", {
          email,
          callbackURL: "/",
          errorCallbackURL: "/magic-link",
        });
        expect(res.status).toBe(200);
      });
      expect(mails).toHaveLength(1);
      expect(mails[0]!.to).toBe(email);
      expect(mails[0]!.html).toContain("Ce lien expire dans 15 minutes.");
      return firstLink(mails[0]!);
    }

    it("emails the dashboard's confirmation page, not the endpoint that spends the token", async () => {
      const link = await requestLink(`magic-${crypto.randomUUID()}@example.test`);

      expect(link.pathname).toBe("/magic-link/confirm");
      expect(link.searchParams.get("token")).toBeTruthy();
    });

    it("is written in the language of the account the address belongs to", async () => {
      const account = await createTestUser({ emailVerified: true });
      await speaksEnglish(account.id);

      const mails = await captureMails(() =>
        postAuth("/sign-in/magic-link", { email: account.email, callbackURL: "/" }),
      );

      expect(mails).toHaveLength(1);
      expect(mails[0]!.subject).toBe("Your sign-in link");
    });

    it("signs in when the page hands its query to the verify endpoint, once", async () => {
      const link = await requestLink(`magic-${crypto.randomUUID()}@example.test`);
      const verify = `/api/auth/magic-link/verify${link.search}`;

      const first = await app.request(verify);
      expect(first.status).toBe(302);
      expect(new URL(first.headers.get("location")!).pathname).toBe("/");
      expect(first.headers.get("set-cookie")).toContain("session_token=");

      // Spent: back to the page that can send another link, with the reason.
      const second = await app.request(verify);
      expect(second.status).toBe(302);
      const location = new URL(second.headers.get("location")!);
      expect(location.pathname).toBe("/magic-link");
      expect(location.searchParams.get("error")).toBeTruthy();
      expect(second.headers.get("set-cookie") ?? "").not.toContain("session_token=");
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

    it("sign-in to an unverified account re-sends the link with the caller's callbackURL", async () => {
      const account = await createTestUser({ emailVerified: false, password: PASSWORD });
      let res!: Response;
      const mails = await captureMails(async () => {
        res = await postAuth("/sign-in/email", {
          email: account.email,
          password: PASSWORD,
          callbackURL: "/invite/some-token",
        });
      });

      expect(res.status).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe("EMAIL_NOT_VERIFIED");
      expect(mails).toHaveLength(1);
      expect(mails[0]!.to).toBe(account.email);
      expect(firstLink(mails[0]!).searchParams.get("callbackURL")).toBe("/invite/some-token");
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

      // What the settings page sends (`EMAIL_CHANGE_CALLBACK_URL`).
      const callbackURL = "/preferences/general?email_change=1";

      const toCurrent = await captureMails(async () => {
        const res = await postAuth("/change-email", { newEmail, callbackURL }, account.cookie);
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
        expect(res.headers.get("location")).toBe(callbackURL);
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
      expect(verifyRes.headers.get("location")).toBe(callbackURL);
      expect(await sessionEmail(account.cookie)).toBe(newEmail);
    });

    it("a link that cannot be honoured returns to the settings page with the error", async () => {
      const account = await createTestUser({ emailVerified: true });
      const newEmail = `new-${crypto.randomUUID()}@example.test`;
      const callbackURL = "/preferences/general?email_change=1";
      const [mail] = await captureMails(() =>
        postAuth("/change-email", { newEmail, callbackURL }, account.cookie),
      );
      const approve = firstLink(mail!);
      approve.searchParams.set("token", "tampered");

      const res = await app.request(`${approve.pathname}${approve.search}`, {
        headers: { Cookie: account.cookie },
      });

      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location")!, "http://x");
      expect(location.pathname).toBe("/preferences/general");
      expect(location.searchParams.get("email_change")).toBe("1");
      expect(location.searchParams.get("error")).toBe("INVALID_TOKEN");
    });
  });

  describe("email change towards an address the environment names", () => {
    const callbackURL = "/preferences/general?email_change=1";
    const savedOwner = process.env.AUTH_BOOTSTRAP_OWNER_EMAIL;

    function nameOwner(email: string | undefined) {
      if (email === undefined) delete process.env.AUTH_BOOTSTRAP_OWNER_EMAIL;
      else process.env.AUTH_BOOTSTRAP_OWNER_EMAIL = email;
      _resetCacheForTesting();
    }

    afterEach(() => {
      nameOwner(savedOwner);
    });

    it("answers as for a taken address and sends nothing", async () => {
      const account = await createTestUser({ emailVerified: true });
      const reserved = `owner-${crypto.randomUUID()}@example.test`;
      nameOwner(reserved);

      const mails = await captureMails(async () => {
        const res = await postAuth(
          "/change-email",
          { newEmail: reserved, callbackURL },
          account.cookie,
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: true });
      });

      expect(mails).toHaveLength(0);
      expect(await sessionEmail(account.cookie)).toBe(account.email);
    });

    it("sends nothing either when the account's own address is unverified", async () => {
      const account = await createTestUser({ emailVerified: false });
      const reserved = `owner-${crypto.randomUUID()}@example.test`;
      nameOwner(reserved);

      const mails = await captureMails(async () => {
        const res = await postAuth(
          "/change-email",
          { newEmail: reserved, callbackURL },
          account.cookie,
        );
        expect(res.status).toBe(200);
      });

      expect(mails).toHaveLength(0);
      expect(await sessionEmail(account.cookie)).toBe(account.email);
    });

    describe("a platform admin's address", () => {
      const admin = "admin-named@example.test";
      const savedAdmins = process.env.AUTH_PLATFORM_ADMIN_EMAILS;

      beforeEach(() => {
        process.env.AUTH_PLATFORM_ADMIN_EMAILS = admin;
        _resetCacheForTesting();
      });

      afterEach(() => {
        if (savedAdmins === undefined) delete process.env.AUTH_PLATFORM_ADMIN_EMAILS;
        else process.env.AUTH_PLATFORM_ADMIN_EMAILS = savedAdmins;
        _resetCacheForTesting();
      });

      it("signing up for it creates nothing and sends no mail", async () => {
        const mails = await captureMails(async () => {
          const res = await postAuth("/sign-up/email", {
            email: admin,
            password: PASSWORD,
            name: "Admin",
          });
          // Better Auth's answer for any sign-up once verification is required.
          expect(res.status).toBe(200);
          expect(((await res.json()) as { token: unknown }).token).toBeNull();
        });

        expect(mails).toHaveLength(0);
        expect(await db.select().from(userTable).where(eq(userTable.email, admin))).toHaveLength(0);
      });

      it("the account that already holds it is still sent its verification link", async () => {
        await createTestUser({ email: admin, password: PASSWORD, emailVerified: false });

        const mails = await captureMails(async () => {
          const res = await postAuth("/sign-in/email", { email: admin, password: PASSWORD });
          expect(res.status).toBe(403);
        });

        expect(mails).toHaveLength(1);
        expect(mails[0]!.to).toBe(admin);
      });
    });

    it("a link issued before the address was named returns to the settings page with the refusal", async () => {
      const account = await createTestUser({ emailVerified: true });
      const target = `owner-${crypto.randomUUID()}@example.test`;
      const [toCurrent] = await captureMails(() =>
        postAuth("/change-email", { newEmail: target, callbackURL }, account.cookie),
      );
      const approve = firstLink(toCurrent!);
      const [toNew] = await captureMails(async () => {
        await app.request(`${approve.pathname}${approve.search}`, {
          headers: { Cookie: account.cookie },
        });
      });
      const verify = firstLink(toNew!);
      nameOwner(target);

      const res = await app.request(`${verify.pathname}${verify.search}`, {
        headers: { Cookie: account.cookie },
      });

      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location")!, "http://x");
      expect(location.pathname).toBe("/preferences/general");
      expect(location.searchParams.get("email_change")).toBe("1");
      expect(location.searchParams.get("error")).toBe("email_change_refused");
      expect(await sessionEmail(account.cookie)).toBe(account.email);
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

  describe("delivery", () => {
    function requestReset(email: string): Promise<Response> {
      return postAuth("/request-password-reset", { email, redirectTo: "/reset-password" });
    }

    it("follows the account, not the address, through an e-mail change", async () => {
      const account = await createTestUser({ emailVerified: true });
      await speaksEnglish(account.id);
      const newEmail = `new-${crypto.randomUUID()}@example.test`;

      const [toCurrent] = await captureMails(() =>
        postAuth("/change-email", { newEmail, callbackURL: "/" }, account.cookie),
      );
      expect(toCurrent!.subject).toBe("Confirm the change of your email address");

      // The new address has no account of its own: only the id finds the language.
      const approve = firstLink(toCurrent!);
      const [toNew] = await captureMails(async () => {
        await app.request(`${approve.pathname}${approve.search}`, {
          headers: { Cookie: account.cookie },
        });
      });
      expect(toNew!.to).toBe(newEmail);
      expect(toNew!.subject).toBe("Verify your email address");
    });

    it("a refused mail changes no answer, and the failure is logged", async () => {
      const account = await createTestUser({ emailVerified: true });
      const delivered = await requestReset(account.email);
      const refusing = {
        sendMail: async (mail: { to: string }) => {
          throw new Error(`550 5.1.1 <${mail.to.toUpperCase()}>: Recipient address rejected`);
        },
      } as unknown as Transporter;
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const refused = await withSmtpOverride(
          { transport: refusing, fromAddress: "refusing@appstrate.test", fromName: null },
          () => requestReset(account.email),
        );

        expect(refused.status).toBe(delivered.status);
        expect(await refused.json()).toEqual(await delivered.json());
        expect(warn).toHaveBeenCalledWith("auth: auth e-mail not sent", {
          template: "reset-password",
          error: "550 5.1.1 <<address>>: Recipient address rejected",
        });
      } finally {
        warn.mockRestore();
      }
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
