// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { renderEmail } from "../src/index.ts";

describe("verification email", () => {
  const baseProps = {
    user: { name: "Alice", email: "alice@example.com" },
    url: "https://app.example.com/verify?token=abc123",
    expiresInMinutes: 60,
  } as const;

  it("renders French verification email", () => {
    const result = renderEmail("verification", { ...baseProps, locale: "fr" });
    expect(result.subject).toBe("Vérifiez votre adresse email");
    expect(result.html).toContain("https://app.example.com/verify?token=abc123");
    expect(result.html).toContain("vérifier votre adresse email");
  });

  it("renders English verification email", () => {
    const result = renderEmail("verification", { ...baseProps, locale: "en" });
    expect(result.subject).toBe("Verify your email address");
    expect(result.html).toContain("verify your email address");
  });

  it("states how long the link stays valid", () => {
    expect(renderEmail("verification", { ...baseProps, locale: "fr" }).html).toContain(
      "Ce lien expire dans 1 heure.",
    );
    expect(renderEmail("verification", { ...baseProps, locale: "en" }).html).toContain(
      "This link expires in 1 hour.",
    );
  });

  // The same template verifies a new address after an email change, so it
  // must not tell an existing user that they just created an account.
  it("does not assume the recipient just signed up", () => {
    const result = renderEmail("verification", { ...baseProps, locale: "fr" });
    expect(result.html).not.toContain("créé de compte");
  });

  it("includes the URL as a clickable link", () => {
    const result = renderEmail("verification", { ...baseProps, locale: "fr" });
    expect(result.html).toContain('href="https://app.example.com/verify?token=abc123"');
  });

  it("escapes ampersands in URL text display", () => {
    const urlWithAmp = "https://app.example.com/verify?token=abc&callbackURL=https://x.com";
    const result = renderEmail("verification", {
      user: { name: "Test", email: "test@example.com" },
      url: urlWithAmp,
      expiresInMinutes: 60,
      locale: "fr",
    });
    expect(result.html).toContain("token=abc&amp;callbackURL=");
    expect(result.html).toContain('href="');
    // href attribute also contains escaped ampersands (valid HTML)
    expect(result.html).not.toContain(`href="${urlWithAmp}"`);
  });
});

describe("invitation email", () => {
  const baseProps = {
    email: "bob@example.com",
    inviteUrl: "https://app.example.com/invite/tok123/accept",
    orgName: "Acme Corp",
    inviterName: "Alice",
    role: "member",
  } as const;

  it("renders French invitation email", () => {
    const result = renderEmail("invitation", { ...baseProps, locale: "fr" });
    expect(result.subject).toBe("Invitation à rejoindre Acme Corp");
    expect(result.html).toContain("https://app.example.com/invite/tok123/accept");
    expect(result.html).toContain("Acme Corp");
    expect(result.html).toContain("Alice");
    expect(result.html).toContain("avec le rôle « Utilisateur standard ».");
  });

  it("renders English invitation email", () => {
    const result = renderEmail("invitation", { ...baseProps, locale: "en" });
    expect(result.subject).toBe("Invitation to join Acme Corp");
    expect(result.html).toContain("Accept the invitation");
    expect(result.html).toContain("with the role “Standard user”.");
  });

  it("escapes HTML in user-provided values", () => {
    const result = renderEmail("invitation", {
      ...baseProps,
      orgName: '<script>alert("xss")</script>',
      inviterName: "Alice <b>Bold</b>",
      locale: "fr",
    });
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("&lt;script&gt;");
    expect(result.html).toContain("&lt;b&gt;");
  });

  it("strips newlines from subject", () => {
    const result = renderEmail("invitation", {
      ...baseProps,
      orgName: "Acme\nCorp",
      locale: "fr",
    });
    expect(result.subject).not.toContain("\n");
  });

  it("includes the invite URL as a clickable link", () => {
    const result = renderEmail("invitation", { ...baseProps, locale: "fr" });
    expect(result.html).toContain('href="https://app.example.com/invite/tok123/accept"');
  });
});

describe("link validity", () => {
  it("is stated in minutes below the hour (magic link, 15 min)", () => {
    const props = {
      email: "a@example.com",
      url: "https://app.example.com/x",
      expiresInMinutes: 15,
    };
    expect(renderEmail("magic-link", { ...props, locale: "fr" }).html).toContain(
      "Ce lien expire dans 15 minutes.",
    );
    expect(renderEmail("magic-link", { ...props, locale: "en" }).html).toContain(
      "This link expires in 15 minutes.",
    );
  });

  it("is stated on the password-reset email", () => {
    const result = renderEmail("reset-password", {
      email: "a@example.com",
      url: "https://app.example.com/x",
      expiresInMinutes: 60,
      locale: "fr",
    });
    expect(result.html).toContain("Ce lien expire dans 1 heure.");
  });
});

describe("email-change confirmation email", () => {
  const props = {
    newEmail: "new@example.com",
    url: "https://app.example.com/api/auth/verify-email?token=abc",
    expiresInMinutes: 60,
  } as const;

  it("names the requested address, links the approval and states the validity", () => {
    const result = renderEmail("email-change-confirmation", { ...props, locale: "fr" });
    expect(result.subject).toBe("Confirmez le changement de votre adresse email");
    expect(result.html).toContain("<strong>new@example.com</strong>");
    expect(result.html).toContain('href="https://app.example.com/api/auth/verify-email?token=abc"');
    expect(result.html).toContain("Ce lien expire dans 1 heure.");
  });

  it("escapes the requested address", () => {
    const result = renderEmail("email-change-confirmation", {
      ...props,
      newEmail: "<b>x</b>@example.com",
      locale: "en",
    });
    expect(result.html).not.toContain("<b>x</b>");
    expect(result.html).toContain("&lt;b&gt;");
  });
});

describe("account notices", () => {
  it("existing-account tells the owner nothing was created, without a link", () => {
    const result = renderEmail("existing-account", { locale: "fr" });
    expect(result.subject).toBe("Vous avez déjà un compte");
    expect(result.html).toContain("Aucun nouveau compte n'a été créé.");
    expect(result.html).not.toContain("href=");
  });

  it("password-changed tells the owner how to react, without a link", () => {
    const result = renderEmail("password-changed", { locale: "en" });
    expect(result.subject).toBe("Your password was changed");
    expect(result.html).toContain("Forgot password");
    expect(result.html).not.toContain("href=");
  });
});
