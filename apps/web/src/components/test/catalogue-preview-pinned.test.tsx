// SPDX-License-Identifier: Apache-2.0

/** The sheet opened on a published version (`?package=…&version=…`) names the version it reads. */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";
import type { LibraryPackageItem, LibrarySpace } from "../../hooks/use-library.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { CataloguePreview } = await import("../catalogue-preview.tsx");
const { cataloguePlacement } = await import("../../lib/catalogue-placement.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const SPACES: LibrarySpace[] = [{ id: "spc_on", name: "Allumé", isDefault: true }];

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
  ],
};

function sheet(pinnedVersion?: string): string {
  return render(
    <CataloguePreview
      item={PACKAGE}
      type="skill"
      spaces={SPACES}
      placement={cataloguePlacement(PACKAGE, "spc_on")}
      gateOf={() => ({ allowed: true, refusal: null })}
      mayConfigureIn={() => true}
      integrations={[]}
      agents={[]}
      pinnedVersion={pinnedVersion}
      busy={false}
      onSetActive={() => {}}
    />,
  );
}

describe("the sheet opened on a published version", () => {
  it("names the version it reads", () => {
    expect(sheet("1.0.0")).toContain("v1.0.0");
  });

  it("names none when none was pinned", () => {
    expect(sheet()).not.toMatch(/>v\d/);
  });
});
