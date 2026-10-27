// SPDX-License-Identifier: Apache-2.0

/**
 * The sheet opened on a published version (`?package=…&version=…`): it names the
 * version it reads, says when the spaces run another one, and offers the way
 * back to the current version.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";
import type { LibraryPackageItem, LibrarySpace } from "../../hooks/use-library.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { CataloguePreview } = await import("../catalogue-preview.tsx");
const { cataloguePlacement } = await import("../../lib/catalogue-placement.ts");
const { versionKeys } = await import("../../lib/query-keys.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");
const settingsFr = (await import("../../locales/fr/settings.json")).default;

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

function sheet(options: { pinnedVersion?: string; latest?: string }): string {
  const queryClient = new QueryClient();
  if (options.latest) {
    queryClient.setQueryData(versionKeys.info(null, null, "skill", PACKAGE.id), {
      latest_published_version: options.latest,
      active_version: null,
    });
  }
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
      pinnedVersion={options.pinnedVersion}
      onUnpin={() => {}}
      busy={false}
      onSetActive={() => {}}
    />,
    { queryClient },
  );
}

describe("the sheet opened on a published version", () => {
  it("names the version it reads and marks it as a version viewed", () => {
    const html = sheet({ pinnedVersion: "1.0.0", latest: "1.0.0" });
    expect(html).toContain("v1.0.0");
    expect(html).toContain(settingsFr["catalogue.sheet.pinned.badge"]);
  });

  it("says the spaces run a newer version, and offers the current one", () => {
    const html = sheet({ pinnedVersion: "1.0.0", latest: "2.0.0" });
    expect(html).toContain(
      settingsFr["catalogue.sheet.pinned.behindTitle"].replace("{{version}}", "1.0.0"),
    );
    expect(html).toContain(settingsFr["catalogue.sheet.pinned.unpin"]);
  });

  it("stays quiet on the latest version", () => {
    const html = sheet({ pinnedVersion: "2.0.0", latest: "2.0.0" });
    expect(html).not.toContain(settingsFr["catalogue.sheet.pinned.unpin"]);
  });

  it("shows no version note when none was pinned", () => {
    const html = sheet({ latest: "2.0.0" });
    expect(html).not.toContain(settingsFr["catalogue.sheet.pinned.badge"]);
    expect(html).not.toContain(settingsFr["catalogue.sheet.pinned.unpin"]);
  });
});
