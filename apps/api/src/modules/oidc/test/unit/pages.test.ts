// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { renderLoginPage } from "../../pages/login.ts";
import { renderConsentPage } from "../../pages/consent.ts";
import { renderMagicLinkPage } from "../../pages/magic-link.ts";
import { renderForgotPasswordPage } from "../../pages/forgot-password.ts";
import { renderResetPasswordPage, renderInvalidTokenPage } from "../../pages/reset-password.ts";
import { PLATFORM_DEFAULT_BRANDING } from "../../services/branding.ts";

const DEFAULT_PROPS = {
  branding: PLATFORM_DEFAULT_BRANDING,
  csrfToken: "tok_test",
  allowSignup: true,
};

describe("renderLoginPage", () => {
  it("escapes raw HTML characters from an error message", () => {
    const out = renderLoginPage({
      ...DEFAULT_PROPS,
      queryString: "?client_id=c1&state=x",
      error: `<img src=x onerror=alert(1)>`,
    }).value;
    expect(out).not.toContain(`<img src=x onerror=alert(1)>`);
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes raw HTML characters from the query string", () => {
    const out = renderLoginPage({
      ...DEFAULT_PROPS,
      queryString: `?state=<x"y>&scope=openid`,
    }).value;
    expect(out).not.toContain(`<x"y>`);
    expect(out).toContain("&lt;x&quot;y&gt;");
    expect(out).toContain("&amp;scope=openid");
  });

  it("pre-fills the email field without breaking out of the attribute", () => {
    const out = renderLoginPage({
      ...DEFAULT_PROPS,
      queryString: "",
      email: `hack"><script>x()</script>`,
    }).value;
    expect(out).not.toContain(`<script>x()</script>`);
    expect(out).toContain("&quot;&gt;&lt;script&gt;x()&lt;/script&gt;");
  });
});

describe("renderConsentPage", () => {
  it("escapes client name and scope list", () => {
    const out = renderConsentPage({
      ...DEFAULT_PROPS,
      clientName: `<img src=x>`,
      scopes: ["openid", "runs:read", `<evil>`],
      action: "/api/oauth/consent?state=x",
    }).value;
    expect(out).not.toContain(`<img src=x>`);
    expect(out).toContain("&lt;img src=x&gt;");
    // Unknown scopes fall back to the raw (escaped) value.
    expect(out).toContain("&lt;evil&gt;");
    // The two form actions echo the escaped URL back.
    expect(out).toContain('action="/api/oauth/consent?state=x"');
  });

  it("renders French labels for known permission-style scopes", () => {
    const out = renderConsentPage({
      ...DEFAULT_PROPS,
      clientName: "Acme",
      scopes: ["openid", "agents:run", "connections:connect"],
      action: "/x",
    }).value;
    expect(out).toContain("Votre identité");
    expect(out).toContain("Lancer des agents pour vous");
    expect(out).toContain("Ajouter des connexions en votre nom");
  });
});

describe("page branding + CSRF", () => {
  const branding = {
    name: "Mon Workspace",
    logoUrl: "https://cdn.example.com/logo.png",
    primaryColor: "#22c55e",
    accentColor: "#16a34a",
    supportEmail: null,
    fromName: "Mon Workspace",
  } as const;

  it("login page shows branded header with logo + primary color in buttons", () => {
    const out = renderLoginPage({
      queryString: "?client_id=c1",
      branding,
      csrfToken: "tok_abcdef",
      allowSignup: true,
    }).value;
    expect(out).toContain('src="https://cdn.example.com/logo.png"');
    expect(out).toContain("Mon Workspace");
    expect(out).toContain("background: #22c55e");
    // Title reflects the branded name
    expect(out).toContain("<title>Connexion à Mon Workspace</title>");
  });

  it("login page injects CSRF hidden field", () => {
    const out = renderLoginPage({
      ...DEFAULT_PROPS,
      queryString: "",
      csrfToken: "tok_abcdef",
    }).value;
    expect(out).toContain('name="_csrf" value="tok_abcdef"');
  });

  it("consent page adds CSRF to both accept and deny forms", () => {
    const out = renderConsentPage({
      ...DEFAULT_PROPS,
      clientName: "Acme",
      scopes: ["openid"],
      action: "/api/oauth/consent",
      csrfToken: "tok_consent",
    }).value;
    const csrfMatches = out.match(/name="_csrf" value="tok_consent"/g);
    expect(csrfMatches).toHaveLength(2);
  });

  it("login page renders magic-link button when smtpEnabled is true", () => {
    const out = renderLoginPage({
      ...DEFAULT_PROPS,
      queryString: "?client_id=c1",
      smtpEnabled: true,
    }).value;
    expect(out).toContain("Recevoir un lien de connexion");
    expect(out).toContain("/api/oauth/magic-link?client_id=c1");
  });

  it("login page omits magic-link button when smtpEnabled is false", () => {
    const out = renderLoginPage({
      ...DEFAULT_PROPS,
      queryString: "?client_id=c1",
      smtpEnabled: false,
    }).value;
    expect(out).not.toContain("Recevoir un lien de connexion");
    expect(out).not.toContain("/api/oauth/magic-link");
  });

  it("login page points forgot-password link at the internal OIDC route", () => {
    const out = renderLoginPage({
      ...DEFAULT_PROPS,
      queryString: "?client_id=c1&state=x",
      smtpEnabled: true,
    }).value;
    expect(out).toContain("/api/oauth/forgot-password?client_id=c1&amp;state=x");
    expect(out).not.toContain('href="/forgot-password"');
  });

  it("consent page uses branded name in the body sentence", () => {
    const out = renderConsentPage({
      clientName: "Acme",
      scopes: ["openid"],
      action: "/x",
      branding,
      csrfToken: "tok_test",
    }).value;
    // Indentation is irrelevant — we only care that the branded name is
    // rendered in the consent body sentence ("votre compte {brand}.").
    expect(out.replace(/\s+/g, " ")).toContain("votre compte Mon Workspace.");
  });
});

describe("renderMagicLinkPage", () => {
  it("renders a form with email field and CSRF hidden input by default", () => {
    const out = renderMagicLinkPage({
      ...DEFAULT_PROPS,
      queryString: "?client_id=c1",
    }).value;
    expect(out).toContain('method="POST"');
    expect(out).toContain('action="/api/oauth/magic-link?client_id=c1"');
    expect(out).toContain('name="email"');
    expect(out).toContain('name="_csrf" value="tok_test"');
    expect(out).toContain("Envoyer le lien");
  });

  it("renders the sent confirmation when sent=true", () => {
    const out = renderMagicLinkPage({
      ...DEFAULT_PROPS,
      queryString: "?client_id=c1",
      email: "user@example.com",
      sent: true,
    }).value;
    expect(out).toContain("Vérifiez votre email");
    expect(out).toContain("user@example.com");
    expect(out).not.toContain('<input type="email"');
  });

  it("escapes malicious email values in the sent confirmation", () => {
    const out = renderMagicLinkPage({
      ...DEFAULT_PROPS,
      queryString: "",
      email: `<script>x()</script>`,
      sent: true,
    }).value;
    expect(out).not.toContain("<script>x()</script>");
    expect(out).toContain("&lt;script&gt;x()&lt;/script&gt;");
  });

  it("preserves the OAuth queryString in the back-to-login link", () => {
    const out = renderMagicLinkPage({
      ...DEFAULT_PROPS,
      queryString: "?client_id=c1&state=x",
    }).value;
    expect(out).toContain("/api/oauth/login?client_id=c1&amp;state=x");
  });
});

describe("renderForgotPasswordPage", () => {
  it("renders the form with email field by default", () => {
    const out = renderForgotPasswordPage({
      ...DEFAULT_PROPS,
      queryString: "?client_id=c1",
    }).value;
    expect(out).toContain('action="/api/oauth/forgot-password?client_id=c1"');
    expect(out).toContain('name="email"');
    expect(out).toContain('name="_csrf" value="tok_test"');
    expect(out).toContain("Envoyer le lien");
  });

  it("renders the sent confirmation when sent=true", () => {
    const out = renderForgotPasswordPage({
      ...DEFAULT_PROPS,
      queryString: "",
      email: "user@example.com",
      sent: true,
    }).value;
    expect(out).toContain("Vérifiez votre email");
    expect(out).toContain("user@example.com");
    expect(out).toContain("/api/oauth/login");
  });

  it("renders error messages escaped", () => {
    const out = renderForgotPasswordPage({
      ...DEFAULT_PROPS,
      queryString: "",
      error: `<img src=x onerror=alert(1)>`,
    }).value;
    expect(out).not.toContain(`<img src=x onerror=alert(1)>`);
    expect(out).toContain("&lt;img");
  });
});

describe("renderResetPasswordPage", () => {
  it("renders the form with both password fields and embeds the token", () => {
    const out = renderResetPasswordPage({
      ...DEFAULT_PROPS,
      queryString: "?client_id=c1",
      token: "tok_reset_abc",
    }).value;
    expect(out).toContain('action="/api/oauth/reset-password?client_id=c1"');
    expect(out).toContain('name="password"');
    expect(out).toContain('name="password_confirm"');
    expect(out).toContain('name="token" value="tok_reset_abc"');
    expect(out).toContain('name="_csrf" value="tok_test"');
  });

  it("escapes tokens that contain HTML-unsafe characters", () => {
    const out = renderResetPasswordPage({
      ...DEFAULT_PROPS,
      queryString: "",
      token: `<"/>`,
    }).value;
    expect(out).not.toContain(`value="<"/>"`);
    expect(out).toContain("&lt;&quot;/&gt;");
  });

  it("renders success screen when success=true", () => {
    const out = renderResetPasswordPage({
      ...DEFAULT_PROPS,
      queryString: "?client_id=c1",
      token: "tok",
      success: true,
    }).value;
    expect(out).toContain("Mot de passe mis à jour");
    expect(out).toContain("/api/oauth/login?client_id=c1");
    expect(out).not.toContain('name="password"');
  });
});

describe("renderInvalidTokenPage", () => {
  it("links to forgot-password to request a new link", () => {
    const out = renderInvalidTokenPage({
      branding: PLATFORM_DEFAULT_BRANDING,
      queryString: "?client_id=c1",
    }).value;
    expect(out).toContain("Lien invalide");
    expect(out).toContain("/api/oauth/forgot-password?client_id=c1");
    expect(out).toContain("/api/oauth/login?client_id=c1");
  });
});
