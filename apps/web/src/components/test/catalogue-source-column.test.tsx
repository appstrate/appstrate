// SPDX-License-Identifier: Apache-2.0

/**
 * The Source column of the integration tables: one label per `source_kind`, and a local MCP server
 * says so when this instance's run adapter cannot isolate a runner.
 */

import { describe, expect, it } from "bun:test";
import type { ReactElement } from "react";
import { installFakeStorage } from "../../test/fake-storage.ts";
import type { IntegrationSource } from "../../lib/integration-collection.ts";
import type { DataColumn } from "../data-table.tsx";

const config = { features: { localIntegrations: true }, trustedOrigins: [] };
installFakeStorage({ __APP_CONFIG__: config });

const { useCatalogueSourceColumn } = await import("../catalogue-columns.tsx");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");
const settingsFr = (await import("../../locales/fr/settings.json")).default;
const settingsEn = (await import("../../locales/en/settings.json")).default;

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

function cell(source: IntegrationSource | undefined, localIntegrations: boolean): string {
  config.features.localIntegrations = localIntegrations;
  let column: DataColumn<{ source?: IntegrationSource }> | undefined;
  function Probe(): ReactElement | null {
    column = useCatalogueSourceColumn((item: { source?: IntegrationSource }) => item.source);
    return null;
  }
  render(<Probe />);
  return render(<>{column!.cell({ source })}</>);
}

describe("the Source column", () => {
  it("words each source kind", () => {
    expect(cell("none", true)).toContain(settingsFr["integrations.source.none"]);
    expect(cell("remote", true)).toContain(settingsFr["integrations.source.remote"]);
    expect(cell("local", true)).toContain(settingsFr["integrations.source.local"]);
    expect(settingsFr["integrations.source.local"]).toBe("MCP local");
    expect(settingsEn["integrations.source.remote"]).toBe("Remote MCP");
  });

  it("flags a local row as unavailable only when the instance cannot isolate it", () => {
    const hint = settingsFr["integrations.source.localUnavailable"];
    const explanation = settingsFr["integrations.source.localUnavailableHint"];
    expect(cell("local", false)).toContain(hint);
    // The explanation is screen-reader text beside the visible hint.
    expect(cell("local", false)).toContain(explanation);
    expect(cell("local", true)).not.toContain(hint);
    expect(cell("remote", false)).not.toContain(hint);
    expect(cell("none", false)).not.toContain(hint);
  });

  it("draws a dash when the source is unknown", () => {
    expect(cell(undefined, true)).toContain("—");
  });
});
