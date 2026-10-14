// SPDX-License-Identifier: Apache-2.0

/** Every package table says where a package comes from with the one origin column. */

import { describe, expect, it } from "bun:test";
import type { ReactElement } from "react";
import { installFakeStorage } from "../../test/fake-storage.ts";
import type { DataColumn } from "../data-table.tsx";
import type { CardItem } from "../../pages/package-list.tsx";
import type { IntegrationSummaryWire } from "../../hooks/use-integrations.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { usePackageColumns } = await import("../package-columns.tsx");
const { useIntegrationListColumns } = await import("../../pages/integration-list-columns.tsx");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");
const settingsFr = (await import("../../locales/fr/settings.json")).default;
const agentsFr = (await import("../../locales/fr/agents.json")).default;

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

function columnsOf<T>(useColumns: () => DataColumn<T>[]): DataColumn<T>[] {
  let columns: DataColumn<T>[] = [];
  function Probe(): ReactElement | null {
    columns = useColumns();
    return null;
  }
  render(<Probe />);
  return columns;
}

const packageOrigin = columnsOf(() => usePackageColumns("agent")).find((c) => c.id === "origin")!;
const integrationOrigin = columnsOf(() => useIntegrationListColumns()).find(
  (c) => c.id === "origin",
)!;

describe("the origin column", () => {
  it("is the same column, under the same header, on the package and integration lists", () => {
    expect(packageOrigin.header).toBe(settingsFr["catalogue.origin"]);
    expect(integrationOrigin.header).toBe(settingsFr["catalogue.origin"]);
  });

  it("names the system the same way on both", () => {
    const system = { id: "@appstrate/x", source: "system" };
    expect(render(<>{packageOrigin.cell(system as CardItem)}</>)).toContain(
      settingsFr["catalogue.sourceSystem"],
    );
    expect(render(<>{integrationOrigin.cell(system as IntegrationSummaryWire)}</>)).toContain(
      settingsFr["catalogue.sourceSystem"],
    );
  });

  it("keeps the mark of a package installed on its own", () => {
    const auto = { id: "@acme/x", source: "local", autoInstalled: true } as CardItem;
    expect(render(<>{packageOrigin.cell(auto)}</>)).toContain(agentsFr["list.badgeAutoInstalled"]);
  });
});
