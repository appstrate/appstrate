// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import { getModuleRegistry } from "../../../src/lib/modules/registry.ts";

describe("getModuleRegistry", () => {
  const originalValue = process.env.APPSTRATE_MODULES;

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.APPSTRATE_MODULES;
    } else {
      process.env.APPSTRATE_MODULES = originalValue;
    }
  });

  it("returns empty array when APPSTRATE_MODULES is unset", () => {
    delete process.env.APPSTRATE_MODULES;
    expect(getModuleRegistry()).toEqual([]);
  });

  it("returns empty array when APPSTRATE_MODULES is empty string", () => {
    process.env.APPSTRATE_MODULES = "";
    expect(getModuleRegistry()).toEqual([]);
  });

  it("parses single module specifier", () => {
    process.env.APPSTRATE_MODULES = "@appstrate/cloud";
    expect(getModuleRegistry()).toEqual(["@appstrate/cloud"]);
  });

  it("parses multiple comma-separated specifiers", () => {
    process.env.APPSTRATE_MODULES = "@appstrate/cloud,@acme/analytics";
    expect(getModuleRegistry()).toEqual(["@appstrate/cloud", "@acme/analytics"]);
  });

  it("trims whitespace around specifiers", () => {
    process.env.APPSTRATE_MODULES = " @appstrate/cloud , @acme/analytics ";
    expect(getModuleRegistry()).toEqual(["@appstrate/cloud", "@acme/analytics"]);
  });

  it("ignores empty segments from trailing commas", () => {
    process.env.APPSTRATE_MODULES = "@appstrate/cloud,,,";
    expect(getModuleRegistry()).toEqual(["@appstrate/cloud"]);
  });
});
