// SPDX-License-Identifier: Apache-2.0

/**
 * What the catalogue says of a package in each space: a placed-but-off switch is told apart from
 * a package never placed there, an offered switch says what switching it on consents to, and the
 * sheet says who offered it.
 */

import { describe, expect, it } from "bun:test";
import type { ReactElement } from "react";
import { installFakeStorage } from "../../test/fake-storage.ts";
import type { LibraryPackageItem, LibrarySpace } from "../../hooks/use-library.ts";
import type { CardItem } from "../../lib/package-card-item.ts";
import type { DataColumn } from "../data-table.tsx";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { useCatalogueSpaceColumns } = await import("../catalogue-columns.tsx");
const { CataloguePreview } = await import("../catalogue-preview.tsx");
const { cataloguePlacement } = await import("../../lib/catalogue-placement.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");
const settingsFr = (await import("../../locales/fr/settings.json")).default;

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const SPACES: LibrarySpace[] = [
  { id: "spc_on", name: "Allumé", isDefault: true },
  { id: "spc_off", name: "Éteint", isDefault: false },
  { id: "spc_offer", name: "Proposé", isDefault: false },
  { id: "spc_none", name: "Absent", isDefault: false },
];

const PACKAGE: LibraryPackageItem = {
  id: "@acme/notes",
  type: "skill",
  source: "local",
  name: "Notes",
  description: "",
  home_space_id: "spc_on",
  home_writable: true,
  home_deletable: true,
  home_shareable: true,
  published: true,
  activation: [],
  placements: [
    { space_id: "spc_on", via: "home", state: "active", chat_enforced: false, shared_by: null },
    {
      space_id: "spc_off",
      via: "shared",
      state: "inactive",
      chat_enforced: false,
      shared_by: null,
    },
    { space_id: "spc_offer", via: "shared", state: "none", chat_enforced: false, shared_by: null },
  ],
};
const PLACEMENT = cataloguePlacement(PACKAGE, "spc_on");
const ALLOWED = { allowed: true, refusal: null } as const;

/** Each space's cell, rendered on its own. */
function cells(): Record<string, string> {
  let columns: DataColumn<CardItem>[] = [];
  function Probe(): ReactElement | null {
    columns = useCatalogueSpaceColumns({
      spaces: SPACES,
      currentSpaceId: "spc_on",
      placementOf: () => PLACEMENT,
      gateOf: () => ALLOWED,
      busy: false,
      onSetActive: () => {},
    });
    return null;
  }
  render(<Probe />);
  const item = { id: PACKAGE.id, displayName: "Notes", type: "skill" } as CardItem;
  return Object.fromEntries(
    SPACES.map((space) => [
      space.id,
      render(<>{columns.find((c) => c.id === `space:${space.id}`)!.cell(item)}</>),
    ]),
  );
}

describe("a package's cell in each space", () => {
  const html = cells();

  it("says « switched off » where it is placed and off, and nothing where it was never placed", () => {
    expect(html.spc_off).toContain(`>${settingsFr["catalogue.filter.inactive"]}<`);
    expect(html.spc_none).not.toContain(`>${settingsFr["catalogue.filter.inactive"]}<`);
    expect(html.spc_on).not.toContain(`>${settingsFr["catalogue.filter.inactive"]}<`);
  });

  it("says on an offered switch what switching it on consents to", () => {
    expect(html.spc_offer).toContain(settingsFr["catalogue.offeredHere"]);
    expect(html.spc_offer).toContain(`title="${settingsFr["catalogue.sheet.offerCredentials"]}"`);
    expect(html.spc_off).not.toContain(settingsFr["catalogue.sheet.offerCredentials"]);
  });
});

describe("the sheet's spaces", () => {
  it("marks the offered space, and says its switch consents to the space's credentials", () => {
    const html = render(
      <CataloguePreview
        item={PACKAGE}
        type="skill"
        spaces={SPACES}
        placement={PLACEMENT}
        gateOf={() => ALLOWED}
        mayConfigureIn={() => true}
        integrations={[]}
        agents={[]}
        busy={false}
        onSetActive={() => {}}
      />,
    );
    expect(html).toContain(settingsFr["catalogue.offeredHere"]);
    expect(html).toContain("Proposé");
  });
});
