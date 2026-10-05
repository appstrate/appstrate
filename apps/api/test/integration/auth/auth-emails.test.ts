// SPDX-License-Identifier: Apache-2.0

/**
 * The e-mails Better Auth sends for the platform's own (non-OIDC) auth flows,
 * read off the wire: which address each goes to, where its link points, and
 * that the link does what the message says.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { _swapMagicLinkIssuedHookForTesting } from "@appstrate/db/auth";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { enableSmtpForSuite, captureMails, firstLink } from "../../helpers/smtp.ts";

// Core only: no OIDC routes, as on an instance whose `MODULES` omits `oidc`.
const app = getTestApp({ modules: [] });

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
});
