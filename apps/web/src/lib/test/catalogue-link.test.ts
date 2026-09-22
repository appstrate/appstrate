// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { catalogueHref } from "../catalogue-link.ts";

describe("catalogueHref", () => {
  it("opens Découvrir on the kind", () => {
    expect(catalogueHref("skill")).toBe("/catalogue/discover/skill");
  });

  it("opens one package's sheet when it names one", () => {
    expect(catalogueHref("agent", { packageId: "@tractr/radar-ia" })).toBe(
      "/catalogue/discover/agent?package=%40tractr%2Fradar-ia",
    );
  });

  it("sends an MCP server to the integrations tab, where local servers live", () => {
    expect(catalogueHref("mcp-server")).toBe("/catalogue/discover/integration");
  });
});
