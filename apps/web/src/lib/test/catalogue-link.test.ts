// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  CATALOGUE_SHARED_HREF,
  catalogueHref,
  catalogueKindAddress,
  CATALOGUE_KINDS,
  catalogueVersionFor,
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

  it("opens the sheet at a published version when it names one", () => {
    expect(catalogueHref("skill", { packageId: "@acme/redactor", version: "1.2.0" })).toBe(
      "/catalogue/discover/skill?package=%40acme%2Fredactor&version=1.2.0",
    );
  });

  it("encodes a pre-release version and ignores a version with no package", () => {
    expect(catalogueHref("agent", { packageId: "@acme/a", version: "2.0.0-beta.1+build" })).toBe(
      "/catalogue/discover/agent?package=%40acme%2Fa&version=2.0.0-beta.1%2Bbuild",
    );
    expect(catalogueHref("agent", { version: "1.0.0" })).toBe("/catalogue/discover/agent");
  });
});

describe("catalogueKindAddress", () => {
  it("moves a reading to a kind and keeps the sheet's package and version", () => {
    const from = { search: "?package=%40acme%2Fredactor&version=1.2.0", hash: "" };
    expect(catalogueKindAddress("discover", "skill", from)).toBe(
      "/catalogue/discover/skill?package=%40acme%2Fredactor&version=1.2.0",
    );
  });

  it("keeps the other params and the hash", () => {
    const from = { search: "?package=%40acme%2Fa&state=active", hash: "#tab" };
    expect(catalogueKindAddress("placed", "integration", from)).toBe(
      "/catalogue/placed/integration?package=%40acme%2Fa&state=active#tab",
    );
  });

  it("is the target of the /catalogue index redirect", () => {
    const from = { search: "?package=%40acme%2Fredactor&version=1.2.0", hash: "" };
    expect(catalogueKindAddress("discover", CATALOGUE_KINDS[0], from)).toBe(
      "/catalogue/discover/agent?package=%40acme%2Fredactor&version=1.2.0",
    );
  });

  it("adds nothing when the address has no query", () => {
    expect(catalogueKindAddress("discover", "agent", { search: "", hash: "" })).toBe(
      "/catalogue/discover/agent",
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
