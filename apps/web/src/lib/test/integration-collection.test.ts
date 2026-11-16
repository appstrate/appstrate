// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { IntegrationIndexItem } from "@appstrate/shared-types";
import { filterIntegrations, integrationOrigin } from "../integration-collection.ts";

function integration({
  id,
  source,
  name = id,
  sourceKind = "remote",
}: {
  id: string;
  source: "local" | "system";
  name?: string;
  sourceKind?: IntegrationIndexItem["source_kind"];
}): IntegrationIndexItem {
  return {
    id,
    source,
    name,
    description: null,
    icon: null,
    keywords: ["fixture"],
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
    source_kind: sourceKind,
    server: sourceKind === "local" ? { type: "node", entry_point: "server/index.js" } : null,
    authenticated: true,
  };
}

const rows = [
  integration({ id: "@appstrate/gmail", source: "system", name: "Gmail", sourceKind: "none" }),
  integration({ id: "@appstrate/slack", source: "system", name: "Slack" }),
  integration({ id: "@acme/qbo", source: "local", name: "QuickBooks", sourceKind: "local" }),
  integration({ id: "@acme/crm", source: "local", name: "CRM" }),
];

const ids = (list: IntegrationIndexItem[]) => list.map((row) => row.id);

describe("filterIntegrations", () => {
  it("combines origin and full-corpus search", () => {
    expect(ids(filterIntegrations(rows, { query: "fixture", origins: ["custom"] }))).toEqual([
      "@acme/qbo",
      "@acme/crm",
    ]);
  });

  it("searches names, package ids and keywords", () => {
    expect(ids(filterIntegrations(rows, { query: "gmail" }))).toEqual(["@appstrate/gmail"]);
    expect(ids(filterIntegrations(rows, { query: "quickbooks" }))).toEqual(["@acme/qbo"]);
    expect(filterIntegrations(rows, { query: "fixture" })).toHaveLength(4);
  });

  it("filters by source kind, one or several", () => {
    expect(ids(filterIntegrations(rows, { query: "", sources: ["local"] }))).toEqual(["@acme/qbo"]);
    expect(ids(filterIntegrations(rows, { query: "", sources: ["none"] }))).toEqual([
      "@appstrate/gmail",
    ]);
    expect(ids(filterIntegrations(rows, { query: "", sources: ["none", "remote"] }))).toEqual([
      "@appstrate/gmail",
      "@appstrate/slack",
      "@acme/crm",
    ]);
    expect(filterIntegrations(rows, { query: "", sources: [] })).toHaveLength(4);
  });
});

describe("origin", () => {
  it("classifies the origin", () => {
    expect(integrationOrigin(rows[0]!)).toBe("system");
    expect(integrationOrigin(rows[2]!)).toBe("custom");
  });
});
