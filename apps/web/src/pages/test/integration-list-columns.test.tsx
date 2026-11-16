// SPDX-License-Identifier: Apache-2.0

/**
 * The integration table's « Connexions » cell: a count once the caller's connections are known,
 * nothing while they are not, and « — » for an integration that binds no connection at all.
 */

import { describe, expect, it } from "bun:test";
import type { IntegrationIndexItem } from "@appstrate/shared-types";
import type { InSpaces } from "../../lib/across-spaces.ts";
import type { DataColumn } from "../../components/data-table.tsx";
import { render } from "../../test/render.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";
import settingsFr from "../../locales/fr/settings.json";
import { useIntegrationListColumns } from "../integration-list-columns.tsx";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

await i18nReady;
await i18n.changeLanguage("fr");

type Row = InSpaces<IntegrationIndexItem>;

function integration(id: string, authenticated: boolean): Row {
  return {
    id,
    spaceId: "spc_a",
    spaceIds: ["spc_a"],
    source: "local",
    name: id,
    description: null,
    icon: null,
    keywords: [],
    version: "1.0.0",
    forked_from: null,
    created_by: null,
    createdAt: "2026-09-05T10:00:00Z",
    updatedAt: "2026-09-05T10:00:00Z",
    used_by_agents: 0,
    auto_installed: false,
    home_space_id: null,
    home_writable: false,
    home_deletable: false,
    home_shareable: false,
    source_kind: "remote",
    server: null,
    authenticated,
  };
}

/** The connections cell of `row`, rendered with `counts` as the caller's counts here. */
function connectionsCell(row: Row, counts?: ReadonlyMap<string, number>): string {
  let column: DataColumn<Row> | undefined;
  const counter = counts && ((sourceId: string) => counts.get(sourceId) ?? 0);
  function Harness() {
    column = useIntegrationListColumns(counter, false).find(({ id }) => id === "connections");
    return null;
  }
  render(<Harness />);
  if (!column) throw new Error("no connections column");
  return render(<>{column.cell(row)}</>);
}

const NOT_REQUIRED = settingsFr["integrations.connectionNotRequired"];

describe("the integration table's connections cell", () => {
  it("draws the count of an integration that binds connections, 0 included", () => {
    const counts = new Map([["@acme/linked", 2]]);
    expect(connectionsCell(integration("@acme/linked", true), counts)).toContain(">2<");
    expect(connectionsCell(integration("@acme/unlinked", true), counts)).toContain(">0<");
  });

  it("draws nothing while the caller's connections are unknown", () => {
    expect(connectionsCell(integration("@acme/linked", true))).toBe("");
  });

  it("draws « — » for an integration that binds no connection, known counts or not", () => {
    for (const counts of [new Map<string, number>(), undefined]) {
      const html = connectionsCell(integration("@acme/open", false), counts);
      expect(html).toContain("—");
      expect(html).toContain(NOT_REQUIRED);
      expect(html).not.toContain(">0<");
    }
  });
});
