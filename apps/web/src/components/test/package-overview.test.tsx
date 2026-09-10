// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from "react";
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { PackageOverview } from "../package-detail/package-overview";
import { ManifestOverview } from "../package-manifest/manifest-overview";
import { Markdown } from "../markdown-impl";
import i18n, { i18nReady } from "../../i18n";

await i18nReady;
await i18n.changeLanguage("fr");
const noop = () => {};
function render(props: Partial<ComponentProps<typeof PackageOverview>> = {}) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <PackageOverview
        type="skill"
        description="Méthode de rapprochement"
        content="Vérifiez les pièces sources."
        manifest={{}}
        version="1.4.0"
        historical={false}
        agentCount={2}
        onOpenFiles={noop}
        onOpenUsage={noop}
        {...props}
      />
    </I18nextProvider>,
  );
}

describe("package overview", () => {
  it("keeps the substance and usage visible when metadata is empty", () => {
    const html = render();
    expect(html).toContain("Méthode de rapprochement");
    expect(html).toContain("Vérifiez les pièces sources.");
    expect(html).toContain("2");
    expect(html).toContain("1.4.0");
    expect(html).not.toContain("Ce manifest ne déclare aucune métadonnée.");
  });
  it("provides a useful MCP summary without inventing a tool count", () => {
    const html = render({ type: "mcp-server", content: null });
    expect(html).toContain("Le manifeste ne fournit pas de catalogue");
    expect(html).not.toContain("Lire les instructions complètes");
    expect(html).toContain("Parcourir les fichiers");
  });
  it("does not offer an empty usage link", () => {
    expect(render({ agentCount: 0 })).not.toContain("Voir les agents utilisateurs");
  });
  it("identifies live usage even when inspecting an archived version", () => {
    expect(render({ historical: true })).toContain("toutes versions confondues");
  });
  it("renders author-controlled previews without links, images or raw HTML", () => {
    const html = renderToStaticMarkup(
      <Markdown inert>
        {
          '# Instructions\n\n**Verify** [the source](https://source.invalid)\n\n![pixel](https://tracking.invalid/pixel)\n\n<img src="https://tracking.invalid/raw"><script>boom()</script>'
        }
      </Markdown>,
    );
    expect(html).toContain("<h1>Instructions</h1>");
    expect(html).toContain("<strong>Verify</strong>");
    expect(html).toContain("the source");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("https://");
  });
  it("can show metadata without duplicating auths and capabilities", () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ManifestOverview
          type="integration"
          metadataOnly
          manifest={{ license: "MIT", auths: { secret_method: { type: "oauth2" } } }}
        />
      </I18nextProvider>,
    );
    expect(html).toContain("MIT");
    expect(html).not.toContain("secret_method");
  });
});
