// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { IntegrationSummaryWire } from "../../hooks/use-integrations.ts";
import {
  filterIntegrations,
  integrationOrigin,
  integrationStatus,
  isOrganizationIntegration,
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
