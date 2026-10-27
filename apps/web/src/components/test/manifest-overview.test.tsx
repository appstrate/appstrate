// SPDX-License-Identifier: Apache-2.0

/**
 * `ManifestOverview` render tests.
 *
 * The web test runner has no DOM, so the component is rendered with
 * `renderToStaticMarkup` and asserted on its HTML — enough for what is under
 * test here: which blocks a manifest produces, and what a manifest string is
 * allowed to become. The reader rules themselves are covered in
 * `lib/test/package-manifest.test.ts`; this file proves the component actually
 * routes through them.
 */

import type { ReactElement } from "react";
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import agentsFr from "../../locales/fr/agents.json";
import i18n, { i18nReady } from "../../i18n.ts";
import { ManifestOverview } from "../package-manifest/manifest-overview.tsx";

// The SPA's own i18n singleton, with the language pinned rather than left to
// whatever the runner defaults to — the assertions read French labels.
await i18nReady;
await i18n.changeLanguage("fr");

function render(node: ReactElement): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

describe("ManifestOverview with a required-fields-only manifest", () => {
  it("renders nothing instead of labelled blanks", () => {
    expect(
      render(
        <ManifestOverview manifest={{ name: "@acme/tidy", version: "1.0.0", type: "skill" }} />,
      ),
    ).toBe("");
  });
});

describe("ManifestOverview links", () => {
  const html = render(
    <ManifestOverview
      manifest={{
        name: "@acme/tidy",
        version: "1.0.0",
        type: "skill",
        homepage: "javascript:alert(document.cookie)",
        repository: { type: "git", url: "https://github.com/acme/tidy" },
      }}
    />,
  );

  it("never turns a non-http(s) manifest string into an href", () => {
    // A manifest is author-controlled: publishing one with this homepage would
    // otherwise hand every viewer's session to its author.
    expect(html).toContain("javascript:alert(document.cookie)");
    expect(html).not.toContain('href="javascript:');
  });

  it("links the URLs that are safe, and opts the tab out of window.opener", () => {
    expect(html).toContain('href="https://github.com/acme/tidy"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe("ManifestOverview shared metadata", () => {
  const html = render(
    <ManifestOverview
      manifest={{
        name: "@acme/tidy",
        version: "2.0.0",
        type: "skill",
        display_name: "Tidy",
        description: "Range vos dépôts",
        long_description: "Un texte plus long.",
        keywords: ["git", "cleanup"],
        license: "Apache-2.0",
        dependencies: { skills: { "@acme/lint": "^1.0.0" } },
      }}
    />,
  );

  it("renders the fields nothing else on the page shows", () => {
    expect(html).toContain("Un texte plus long.");
    expect(html).toContain("git");
    expect(html).toContain("Apache-2.0");
    expect(html).toContain("@acme/lint");
    expect(html).toContain(agentsFr["manifest.depSkills"]);
  });

  it("leaves the fields the page header already carries to the header", () => {
    expect(html).not.toContain("Tidy");
    expect(html).not.toContain("Range vos dépôts");
    expect(html).not.toContain("2.0.0");
  });
});
