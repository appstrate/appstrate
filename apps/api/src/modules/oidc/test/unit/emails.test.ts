// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { renderEndUserWelcomeEmail } from "../../emails/enduser-welcome.ts";
import { renderEndUserVerificationEmail } from "../../emails/enduser-verification.ts";
import { renderEndUserResetPasswordEmail } from "../../emails/enduser-reset-password.ts";

describe("OIDC email templates", () => {
  describe("enduser-welcome", () => {
    it("renders subject + html", () => {
      const r = renderEndUserWelcomeEmail({
        name: "Alice",
        email: "alice@example.com",
        applicationName: "Acme Portal",
      });
      expect(r.subject).toBe("Bienvenue sur Acme Portal");
      expect(r.html).toContain("Bienvenue, Alice.");
      expect(r.html).toContain("<strong>Acme Portal</strong>");
    });

    it("escapes application name in subject metadata and body", () => {
      const r = renderEndUserWelcomeEmail({
        name: "<img src=x>",
        email: "x@y.com",
        applicationName: "<script>alert(1)</script>",
      });
      expect(r.html).not.toContain("<script>alert(1)</script>");
      expect(r.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(r.html).not.toContain("<img src=x>");
      expect(r.html).toContain("&lt;img src=x&gt;");
    });
  });

  describe("enduser-verification", () => {
    it("renders a clickable verification link", () => {
      const r = renderEndUserVerificationEmail({
        name: "Alice",
        email: "alice@example.com",
        applicationName: "Acme",
        verifyUrl: "https://acme.example.com/verify?token=abc",
      });
      expect(r.subject).toContain("Acme");
      expect(r.html).toContain('href="https://acme.example.com/verify?token=abc"');
      expect(r.html).toContain("Confirmer mon email");
    });

    it("escapes the URL in case of malicious input", () => {
      const r = renderEndUserVerificationEmail({
        name: "Alice",
        email: "a@b.com",
        applicationName: "Acme",
        verifyUrl: 'https://evil.example.com/"><script>alert(1)</script>',
      });
      expect(r.html).not.toContain("<script>alert(1)</script>");
    });
  });

  describe("enduser-reset-password", () => {
    it("includes the reset URL and a 1h expiry notice", () => {
      const r = renderEndUserResetPasswordEmail({
        name: "Alice",
        email: "a@b.com",
        applicationName: "Acme",
        resetUrl: "https://acme.example.com/reset?token=xyz",
      });
      expect(r.html).toContain("https://acme.example.com/reset?token=xyz");
      expect(r.html).toContain("1 heure");
      expect(r.html).toContain("Réinitialiser mon mot de passe");
    });
  });
});
