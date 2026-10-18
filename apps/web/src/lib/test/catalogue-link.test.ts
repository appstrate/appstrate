// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  catalogueHref,
  catalogueKindAddress,
  catalogueListAddress,
  catalogueSheetAddress,
  catalogueVersionFor,
  catalogueViewOf,
  isCatalogueKind,
} from "../catalogue-link.ts";

describe("catalogueHref", () => {
  it("opens Découvrir on the kind", () => {
    expect(catalogueHref("skill")).toBe("/catalogue/skill");
  });

  it("opens one package's sheet when it names one", () => {
    expect(catalogueHref("agent", { packageId: "@acme/radar-ia" })).toBe(
      "/catalogue/agent?package=%40acme%2Fradar-ia",
    );
  });

  it("opens an MCP server on its own kind", () => {
    expect(catalogueHref("mcp-server")).toBe("/catalogue/mcp-server");
  });

  it("opens the sheet at a published version when it names one", () => {
    expect(catalogueHref("skill", { packageId: "@acme/redactor", version: "1.2.0" })).toBe(
      "/catalogue/skill?package=%40acme%2Fredactor&version=1.2.0",
    );
  });

  it("encodes a pre-release version and ignores a version with no package", () => {
    expect(catalogueHref("agent", { packageId: "@acme/a", version: "2.0.0-beta.1+build" })).toBe(
      "/catalogue/agent?package=%40acme%2Fa&version=2.0.0-beta.1%2Bbuild",
    );
    expect(catalogueHref("agent", { version: "1.0.0" })).toBe("/catalogue/agent");
  });
});

describe("catalogueKindAddress", () => {
  it("keeps the view, the other params and the hash", () => {
    const from = { search: "?view=spaces&package=%40acme%2Fa&state=active", hash: "#tab" };
    expect(catalogueKindAddress("integration", from)).toBe(
      "/catalogue/integration?view=spaces&package=%40acme%2Fa&state=active#tab",
    );
  });

  it("adds nothing when the address has no query", () => {
    expect(catalogueKindAddress("agent", { search: "", hash: "" })).toBe("/catalogue/agent");
  });
});

describe("catalogueSheetAddress", () => {
  const from = { search: "?package=%40acme%2Fredactor&version=1.2.0", hash: "#notes" };

  it("leaves the address alone when no package is named", () => {
    expect(catalogueSheetAddress("agent", undefined, from)).toBeNull();
  });

  it("leaves the address alone when the package is of the kind shown", () => {
    expect(catalogueSheetAddress("skill", "skill", from)).toBeNull();
  });

  it("moves a package of another kind to its kind, in the same view", () => {
    expect(catalogueSheetAddress("agent", "skill", from)).toBe(
      "/catalogue/skill?package=%40acme%2Fredactor&version=1.2.0#notes",
    );
    const spaces = { search: "?view=spaces&package=%40acme%2Fredactor", hash: "" };
    expect(catalogueSheetAddress("agent", "integration", spaces)).toBe(
      "/catalogue/integration?view=spaces&package=%40acme%2Fredactor",
    );
  });
});

describe("catalogueVersionFor", () => {
  const base = { isHistoricalVersion: true, source: "local", version: "1.2.0" };

  it("pins the version the reader chose on the /:version route", () => {
    expect(catalogueVersionFor(base)).toBe("1.2.0");
  });

  it("leaves the live page unpinned, so its link follows the current version", () => {
    expect(catalogueVersionFor({ ...base, isHistoricalVersion: false })).toBeUndefined();
  });

  it("never pins a system package, which answers no version", () => {
    expect(catalogueVersionFor({ ...base, source: "system" })).toBeUndefined();
  });

  it("pins nothing when the version is not known", () => {
    expect(catalogueVersionFor({ ...base, version: null })).toBeUndefined();
    expect(catalogueVersionFor({ ...base, version: undefined })).toBeUndefined();
  });
});

describe("catalogueListAddress", () => {
  it("closes the sheet and keeps search and filters on a kind change", () => {
    const search = "?view=spaces&q=radar&state=active&package=%40acme%2Fa&version=1.0.0";
    expect(catalogueListAddress("skill", "spaces", search)).toBe(
      "/catalogue/skill?view=spaces&q=radar&state=active",
    );
  });

  it("drops the state filter when the view changes, either way", () => {
    expect(catalogueListAddress("agent", "discover", "?view=spaces&q=radar&state=active")).toBe(
      "/catalogue/agent?q=radar",
    );
    expect(catalogueListAddress("agent", "spaces", "?origin=local&state=active")).toBe(
      "/catalogue/agent?origin=local&view=spaces",
    );
  });

  it("writes Découvrir as no view at all", () => {
    expect(catalogueListAddress("mcp-server", "discover", "")).toBe("/catalogue/mcp-server");
  });
});

describe("catalogue addresses", () => {
  it("name a kind, and a view in the query", () => {
    expect(isCatalogueKind("mcp-server")).toBe(true);
    expect(catalogueViewOf("")).toBe("discover");
    expect(catalogueViewOf("?q=radar")).toBe("discover");
    expect(catalogueViewOf("?view=spaces&q=radar")).toBe("spaces");
  });

  it("refuse a kind or a view the catalogue does not have", () => {
    expect(isCatalogueKind("all")).toBe(false);
    expect(isCatalogueKind("agents")).toBe(false);
    // One address per view: Découvrir is the param's absence, and the param is named once.
    expect(catalogueViewOf("?view=discover")).toBeNull();
    expect(catalogueViewOf("?view=")).toBeNull();
    expect(catalogueViewOf("?view=SPACES")).toBeNull();
    expect(catalogueViewOf("?view=spaces&view=spaces")).toBeNull();
  });
});
