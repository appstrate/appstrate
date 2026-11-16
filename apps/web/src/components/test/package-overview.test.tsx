// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from "react";
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { PackageOverview } from "../package-detail/package-overview";
import { Markdown } from "../markdown-impl";
import i18n, { i18nReady } from "../../i18n";

await i18nReady;
await i18n.changeLanguage("fr");
const noop = () => {};
function render(props: Partial<ComponentProps<typeof PackageOverview>> = {}) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <PackageOverview
        content="Vérifiez les pièces sources."
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
  it("shows what the package does here, not what the catalogue sheet says it is", () => {
    const html = render();
    expect(html).toContain("Vérifiez les pièces sources.");
    expect(html).toContain("2");
    expect(html).not.toContain("Méthode de rapprochement");
    expect(html).not.toContain("1.4.0");
    expect(html).not.toContain("MIT");
  });
  it("previews the instructions, not the frontmatter that names the skill", () => {
    const html = render({
      content:
        "---\nname: rapprochement\ndescription: Rapproche les pièces.\n---\n\nVérifiez les pièces sources.",
    });
    expect(html).toContain("Vérifiez les pièces sources.");
    expect(html).not.toContain("name: rapprochement");
    expect(html).not.toContain("<h2>");
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
});
