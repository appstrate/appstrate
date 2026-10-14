// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { IntegrationIndexItem } from "@appstrate/shared-types";
import {
  filterIntegrations,
  integrationExecution,
  integrationOrigin,
  integrationProtocol,
} from "../integration-collection.ts";

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
    server: sourceKind === "local" ? { name: `${id}-server`, version: "^1.0.0" } : null,
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

  it("splits by execution and protocol off the row's source kind", () => {
    expect(ids(filterIntegrations(rows, { query: "", executions: ["local"] }))).toEqual([
      "@acme/qbo",
    ]);
    expect(
      ids(filterIntegrations(rows, { query: "", executions: ["remote"], protocols: ["api"] })),
    ).toEqual(["@appstrate/gmail"]);
  });
});

describe("source kind", () => {
  it("runs locally only for a local source", () => {
    expect(integrationExecution("local")).toBe("local");
    expect(integrationExecution("remote")).toBe("remote");
    expect(integrationExecution("none")).toBe("remote");
  });

  it("is MCP unless the source has no MCP backing", () => {
    expect(integrationProtocol("local")).toBe("mcp");
    expect(integrationProtocol("remote")).toBe("mcp");
    expect(integrationProtocol("none")).toBe("api");
  });

  it("classifies the origin", () => {
    expect(integrationOrigin(rows[0]!)).toBe("system");
    expect(integrationOrigin(rows[2]!)).toBe("custom");
  });
});
