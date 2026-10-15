// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  CATALOGUE_SHARED_HREF,
  catalogueHref,
  isCatalogueKind,
  isCatalogueReading,
} from "../catalogue-link.ts";

describe("catalogueHref", () => {
  it("opens Découvrir on the kind", () => {
    expect(catalogueHref("skill")).toBe("/catalogue/discover/skill");
  });

  it("opens one package's sheet when it names one", () => {
    expect(catalogueHref("agent", { packageId: "@acme/radar-ia" })).toBe(
      "/catalogue/discover/agent?package=%40acme%2Fradar-ia",
    );
  });

  it("opens an MCP server on its own kind", () => {
    expect(catalogueHref("mcp-server")).toBe("/catalogue/discover/mcp-server");
  });
});

describe("catalogue addresses", () => {
  it("name a reading and a kind, the shares list included", () => {
    expect(CATALOGUE_SHARED_HREF).toBe("/catalogue/shared/agent");
    expect(isCatalogueReading("shared")).toBe(true);
    expect(isCatalogueKind("mcp-server")).toBe(true);
  });

  it("refuse a reading or a kind the catalogue does not have", () => {
    expect(isCatalogueReading("origin")).toBe(false);
    expect(isCatalogueKind("all")).toBe(false);
    expect(isCatalogueKind("agents")).toBe(false);
  });
});
