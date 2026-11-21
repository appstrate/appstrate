// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from "react";
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { PackageOverview } = await import("../package-detail/package-overview");
const { Markdown } = await import("../markdown-impl");
const { memberSpaceClient, renderInSpace, testSpace } = await import("../../test/space-context.ts");
const i18nModule = await import("../../i18n");
const i18n = i18nModule.default;

await i18nModule.i18nReady;
await i18n.changeLanguage("fr");
const t = i18n.getFixedT("fr", "settings");
const noop = () => {};

const AVAILABILITY = {
  via: "home",
  state: "inactive",
  shared_by: null,
  offered_to_org: false,
  org_offerable: false,
  active_by_default: false,
} as const;

function render(
  props: Partial<ComponentProps<typeof PackageOverview>> = {},
  { overview = false }: { overview?: boolean } = {},
) {
  return renderInSpace(
    <PackageOverview
      packageId="@acme/rapprochement"
      type="skill"
      name="Rapprochement"
      availability={AVAILABILITY}
      content="Vérifiez les pièces sources."
      historical={false}
      agentCount={2}
      onOpenFiles={noop}
      onOpenUsage={noop}
      {...props}
    />,
    {
      overview,
      queryClient: memberSpaceClient([
        testSpace("spc_a", ["skills:read"], "Studio"),
        testSpace("spc_b", ["skills:read"], "Coffre"),
      ]),
      initialEntries: ["/skills/@acme/rapprochement"],
    },
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
  describe("the availability card", () => {
    it("says how the working space got the skill, in the masculine", () => {
      const html = render();
      expect(html).toContain(t("packages.availability.title"));
      expect(html).toContain("Non activé · espace d’origine");
    });
    it("is hidden in « Tous les espaces », which has no working-space answer", () => {
      expect(render({}, { overview: true })).not.toContain(t("packages.availability.title"));
    });
    it("is absent when the detail carries no availability", () => {
      expect(render({ availability: undefined })).not.toContain(t("packages.availability.title"));
    });
    it("says a package the deployment activates everywhere takes no offer", () => {
      const html = render({ availability: { ...AVAILABILITY, active_by_default: true } });
      expect(html).toContain(t("catalogue.orgOffer.defaultActive"));
      expect(html).not.toContain(t("catalogue.orgOffer.label"));
    });
    it("draws the offer row only when the offer stands or the reader may change it", () => {
      expect(render()).not.toContain(t("catalogue.orgOffer.label"));
      const html = render({ availability: { ...AVAILABILITY, org_offerable: true } });
      expect(html).toContain(t("catalogue.orgOffer.label"));
    });
  });
});
