// SPDX-License-Identifier: Apache-2.0

/** A connection's expiry is a date in the interface's language, not the runtime's. */

import { afterAll, describe, expect, it } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n, { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import type {
  IntegrationConnection,
  IntegrationManifestView,
} from "../../../hooks/use-integrations.ts";
import type { DataColumn } from "../../data-table.tsx";
import { useConnectionColumns } from "../integration-columns.tsx";

await i18nReady;
afterAll(() => i18n.changeLanguage("fr"));

function expiresCell(): DataColumn<IntegrationConnection>["cell"] {
  let columns: DataColumn<IntegrationConnection>[] = [];
  function Probe(): ReactElement | null {
    columns = useConnectionColumns({
      packageId: "@appstrate/google-drive",
      authKey: "drive",
      authType: "oauth2",
      canRenew: true,
      manifest: {} as IntegrationManifestView,
      userId: "user_1",
      isAdmin: false,
    });
    return null;
  }
  render(<Probe />);
  return columns.find((column) => column.id === "expires")!.cell;
}

const CONNECTION = { expiresAt: "2026-03-04T12:00:00Z" } as IntegrationConnection;

describe("the connection expiry column", () => {
  it("writes the date the French way in French", async () => {
    await i18n.changeLanguage("fr");
    expect(renderToStaticMarkup(<>{expiresCell()(CONNECTION)}</>)).toContain("04/03/2026");
  });

  it("CONTROL: and the American way in English", async () => {
    await i18n.changeLanguage("en");
    expect(renderToStaticMarkup(<>{expiresCell()(CONNECTION)}</>)).toContain("03/04/2026");
  });
});
