// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { IntegrationSummaryWire } from "../../hooks/use-integrations.ts";
import {
  catalogueFilterSearch,
  catalogueSearch,
  filterIntegrations,
  integrationOrigin,
  integrationStatus,
  isCatalogueIntegration,
  isOrganizationIntegration,
  readCatalogueFilters,
} from "../integration-collection.ts";

function integration({
  id,
  source,
  active,
  displayName = id,
}: {
  id: string;
  source: "local" | "system";
  active: boolean;
  displayName?: string;
}): IntegrationSummaryWire {
  return {
    id,
    source,
    active,
    orgId: source === "local" ? "org_1" : null,
    manifest: {
      name: id,
      type: "integration",
      version: "1.0.0",
      display_name: displayName,
      keywords: ["fixture"],
      source: {
        kind: "remote",
        remote: { url: "https://example.test/mcp", transport: "streamable-http" },
      },
      auths: {},
    },
  };
}

const rows = [
  integration({ id: "@appstrate/gmail", source: "system", active: true, displayName: "Gmail" }),
  integration({ id: "@appstrate/slack", source: "system", active: false, displayName: "Slack" }),
  integration({ id: "@acme/qbo", source: "local", active: true, displayName: "QuickBooks" }),
  integration({ id: "@acme/legacy", source: "local", active: false, displayName: "Legacy" }),
];

describe("integration collection predicates", () => {
  it("keeps active system integrations and every custom integration", () => {
    expect(rows.filter(isOrganizationIntegration).map((row) => row.id)).toEqual([
      "@appstrate/gmail",
      "@acme/qbo",
      "@acme/legacy",
    ]);
  });

  it("keeps every system integration in the catalogue", () => {
    expect(rows.filter(isCatalogueIntegration).map((row) => row.id)).toEqual([
      "@appstrate/gmail",
      "@appstrate/slack",
    ]);
  });
});

describe("filterIntegrations", () => {
  it("combines status, origin and full-corpus search", () => {
    expect(
      filterIntegrations(rows, {
        query: "legacy",
        statuses: ["inactive"],
        origins: ["custom"],
      }).map((row) => row.id),
    ).toEqual(["@acme/legacy"]);
  });

  it("searches names, package ids and keywords", () => {
    expect(filterIntegrations(rows, { query: "gmail" }).map((row) => row.id)).toEqual([
      "@appstrate/gmail",
    ]);
    expect(filterIntegrations(rows, { query: "fixture" })).toHaveLength(4);
  });

  it("classifies the facts used by filters, cards and columns once", () => {
    expect(integrationStatus(rows[0]!)).toBe("active");
    expect(integrationStatus(rows[1]!)).toBe("inactive");
    expect(integrationOrigin(rows[0]!)).toBe("system");
    expect(integrationOrigin(rows[2]!)).toBe("custom");
  });
});

describe("catalogueSearch", () => {
  it("opens and closes the catalogue without losing list state", () => {
    const opened = catalogueSearch("?q=mail&status=active", true);
    expect(opened).toBe("?q=mail&status=active&catalogue=1");
    expect(catalogueSearch(opened, false)).toBe("?q=mail&status=active");
  });

  it("keeps catalogue filters addressable without colliding with the main list", () => {
    const filtered = catalogueFilterSearch("?q=mail&catalogue=1", {
      query: "drive",
      statuses: ["inactive"],
    });
    expect(filtered).toBe("?q=mail&catalogue=1&catalogue_q=drive&catalogue_status=inactive");
    expect(readCatalogueFilters(filtered)).toEqual({ query: "drive", statuses: ["inactive"] });
    expect(catalogueSearch(filtered, false)).toBe("?q=mail");
  });

  it("represents every catalogue rail destination in the existing status URL", () => {
    const active = catalogueFilterSearch("?catalogue=1", {
      query: "",
      statuses: ["active"],
    });
    expect(readCatalogueFilters(active)).toEqual({ query: "", statuses: ["active"] });

    const inactive = catalogueFilterSearch(active, {
      query: "",
      statuses: ["inactive"],
    });
    expect(readCatalogueFilters(inactive)).toEqual({ query: "", statuses: ["inactive"] });

    const all = catalogueFilterSearch(inactive, { query: "", statuses: [] });
    expect(all).toBe("?catalogue=1");
    expect(readCatalogueFilters(all)).toEqual({ query: "", statuses: [] });
  });

  it("ignores unknown catalogue status values from the URL", () => {
    expect(readCatalogueFilters("?catalogue_status=active,retired")).toEqual({
      query: "",
      statuses: ["active"],
    });
  });
});
