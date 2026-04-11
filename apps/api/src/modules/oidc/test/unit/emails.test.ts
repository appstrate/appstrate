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

  describe("branding overrides", () => {
    const branding = {
      name: "Mon Workspace",
      logoUrl: "https://cdn.example.com/logo.png",
      primaryColor: "#22c55e",
      accentColor: "#16a34a",
      supportEmail: null,
      fromName: "Mon Workspace",
    } as const;

    it("uses branded name in welcome subject + body over applicationName fallback", () => {
      const r = renderEndUserWelcomeEmail({
        name: "Alice",
        email: "a@b.com",
        applicationName: "Platform Fallback",
        branding,
      });
      expect(r.subject).toBe("Bienvenue sur Mon Workspace");
      expect(r.html).toContain("<strong>Mon Workspace</strong>");
      expect(r.html).not.toContain("Platform Fallback");
    });

    it("injects logo + branded header in the email shell", () => {
      const r = renderEndUserVerificationEmail({
        name: "Alice",
        email: "a@b.com",
        applicationName: "Fallback",
        verifyUrl: "https://acme.example.com/verify?token=abc",
        branding,
      });
      expect(r.html).toContain('src="https://cdn.example.com/logo.png"');
      expect(r.html).toContain("Mon Workspace");
      // Primary button color should match branding
      expect(r.html).toContain("background:#22c55e");
    });

    it("falls back to default color when branding hex is malformed", () => {
      const r = renderEndUserResetPasswordEmail({
        name: "Alice",
        email: "a@b.com",
        applicationName: "Acme",
        resetUrl: "https://acme.example.com/reset?token=xyz",
        branding: {
          name: "Acme",
          logoUrl: null,
          primaryColor: "javascript:alert(1)" as string,
          accentColor: "#4338ca",
          supportEmail: null,
          fromName: "Acme",
        },
      });
      expect(r.html).toContain("background:#4f46e5");
      expect(r.html).not.toContain("javascript:alert(1)");
    });

    it("escapes malicious logo URL inside the shell header", () => {
      const r = renderEndUserWelcomeEmail({
        name: "Alice",
        email: "a@b.com",
        applicationName: "Acme",
        branding: {
          name: 'Mon Workspace"<script>alert(1)</script>',
          logoUrl: 'https://evil.example.com/"><script>x()</script>',
          primaryColor: "#4f46e5",
          accentColor: "#4338ca",
          supportEmail: null,
          fromName: "Mon Workspace",
        },
      });
      expect(r.html).not.toContain("<script>alert(1)</script>");
      expect(r.html).not.toContain("<script>x()</script>");
    });
  });
});
