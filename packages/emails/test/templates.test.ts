// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { renderEmail } from "../src/index.ts";

describe("verification email", () => {
  const baseProps = {
    user: { name: "Alice", email: "alice@example.com" },
    url: "https://app.example.com/verify?token=abc123",
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

  it("includes the URL as a clickable link", () => {
    const result = renderEmail("verification", { ...baseProps, locale: "fr" });
    expect(result.html).toContain('href="https://app.example.com/verify?token=abc123"');
  });

  it("escapes ampersands in URL text display", () => {
    const urlWithAmp = "https://app.example.com/verify?token=abc&callbackURL=https://x.com";
    const result = renderEmail("verification", {
      user: { name: "Test", email: "test@example.com" },
      url: urlWithAmp,
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
    role: "admin",
  } as const;

  it("renders French invitation email", () => {
    const result = renderEmail("invitation", { ...baseProps, locale: "fr" });
    expect(result.subject).toBe("Invitation à rejoindre Acme Corp");
    expect(result.html).toContain("https://app.example.com/invite/tok123/accept");
    expect(result.html).toContain("Acme Corp");
    expect(result.html).toContain("Alice");
    expect(result.html).toContain("admin");
  });

  it("renders English invitation email", () => {
    const result = renderEmail("invitation", { ...baseProps, locale: "en" });
    expect(result.subject).toBe("Invitation to join Acme Corp");
    expect(result.html).toContain("Accept the invitation");
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
