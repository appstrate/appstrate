// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { catalogueHref } from "../catalogue-link.ts";

describe("catalogueHref", () => {
  it("narrows to the space the reader came from", () => {
    expect(catalogueHref("agent", "spc_a")).toBe("/catalogue/placed/agent?space=spc_a");
  });

  it("opens the whole map when no space named the way in", () => {
    expect(catalogueHref("skill")).toBe("/catalogue/placed/skill");
    expect(catalogueHref("skill", null)).toBe("/catalogue/placed/skill");
  });

  it("sends an MCP server to the integrations tab, where local servers live", () => {
    expect(catalogueHref("mcp-server", "spc_a")).toBe("/catalogue/placed/integration?space=spc_a");
  });
});
