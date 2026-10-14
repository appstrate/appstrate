// SPDX-License-Identifier: Apache-2.0

/** A connection's expiry is a date in the interface's language, not the runtime's. */

import { afterAll, describe, expect, it } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n, { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import type {
  IntegrationClient,
  IntegrationConnection,
  IntegrationManifestView,
} from "../../../hooks/use-integrations.ts";
import type { ClientRow } from "../../../lib/integration-clients.ts";
import type { DataColumn } from "../../data-table.tsx";
import { clientDeeds, clientLevelKey, useConnectionColumns } from "../integration-columns.tsx";

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

function clientRow(level: ClientRow["level"], autoProvisioned = false): ClientRow {
  const client: IntegrationClient = {
    client_ref: `${level}_a`,
    source: level,
    client_id: `${level}_a.apps.example.com`,
    is_default: false,
    auto_provisioned: autoProvisioned,
    has_client_secret: true,
    token_endpoint_auth_method: null,
    redirect_uri: null,
  };
  return { client, level, usedHere: false, orgDefault: false, inSpaceList: true, inOrgList: false };
}

describe("an OAuth client's level", () => {
  it("names the tier, and an auto-provisioned space client apart", () => {
    expect(clientLevelKey(clientRow("system"))).toBe("source.builtIn");
    expect(clientLevelKey(clientRow("org"))).toBe("source.org");
    expect(clientLevelKey(clientRow("space"))).toBe("source.space");
    expect(clientLevelKey(clientRow("space", true))).toBe("source.autoProvisioned");
  });
});

describe("what may be done to an OAuth client", () => {
  it("edits a space's own client, an org one only for an org admin, the system's never", () => {
    expect(clientDeeds(clientRow("space"), false)).toEqual({ ownLevel: true, editable: true });
    expect(clientDeeds(clientRow("org"), false)).toEqual({ ownLevel: false, editable: false });
    expect(clientDeeds(clientRow("org"), true)).toEqual({ ownLevel: true, editable: true });
    expect(clientDeeds(clientRow("system"), true)).toEqual({ ownLevel: false, editable: false });
  });

  it("deletes an auto-provisioned client but never edits it", () => {
    expect(clientDeeds(clientRow("space", true), true)).toEqual({
      ownLevel: true,
      editable: false,
    });
  });
});
