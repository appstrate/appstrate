// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { renderLoginPage } from "../../pages/login.ts";
import { renderConsentPage } from "../../pages/consent.ts";
import { PLATFORM_DEFAULT_BRANDING } from "../../services/branding.ts";

const DEFAULT_PROPS = {
  branding: PLATFORM_DEFAULT_BRANDING,
  csrfToken: "tok_test",
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
      action: "/api/oauth/enduser/consent?state=x",
    }).value;
    expect(out).not.toContain(`<img src=x>`);
    expect(out).toContain("&lt;img src=x&gt;");
    // Unknown scopes fall back to the raw (escaped) value.
    expect(out).toContain("&lt;evil&gt;");
    // The two form actions echo the escaped URL back.
    expect(out).toContain('action="/api/oauth/enduser/consent?state=x"');
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
      action: "/api/oauth/enduser/consent",
      csrfToken: "tok_consent",
    }).value;
    const csrfMatches = out.match(/name="_csrf" value="tok_consent"/g);
    expect(csrfMatches).toHaveLength(2);
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
