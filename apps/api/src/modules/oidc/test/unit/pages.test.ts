// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { renderLoginPage } from "../../pages/login.ts";
import { renderConsentPage } from "../../pages/consent.ts";

describe("renderLoginPage", () => {
  it("escapes raw HTML characters from an error message", () => {
    const out = renderLoginPage({
      queryString: "?client_id=c1&state=x",
      error: `<img src=x onerror=alert(1)>`,
    }).value;
    expect(out).not.toContain(`<img src=x onerror=alert(1)>`);
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes raw HTML characters from the query string", () => {
    const out = renderLoginPage({
      queryString: `?state=<x"y>&scope=openid`,
    }).value;
    expect(out).not.toContain(`<x"y>`);
    expect(out).toContain("&lt;x&quot;y&gt;");
    expect(out).toContain("&amp;scope=openid");
  });

  it("pre-fills the email field without breaking out of the attribute", () => {
    const out = renderLoginPage({
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
      clientName: `<img src=x>`,
      scopes: ["openid", "runs", `<evil>`],
      action: "/api/oauth/enduser/consent?state=x",
    }).value;
    expect(out).not.toContain(`<img src=x>`);
    expect(out).toContain("&lt;img src=x&gt;");
    // Unknown scopes fall back to the raw (escaped) value.
    expect(out).toContain("&lt;evil&gt;");
    // The two form actions echo the escaped URL back.
    expect(out).toContain('action="/api/oauth/enduser/consent?state=x"');
  });

  it("renders French labels for known scopes", () => {
    const out = renderConsentPage({
      clientName: "Acme",
      scopes: ["openid", "runs:write", "connections:write"],
      action: "/x",
    }).value;
    expect(out).toContain("Votre identité");
    expect(out).toContain("Lancer des agents pour vous");
    expect(out).toContain("Vos connexions (lecture et écriture)");
  });
});
