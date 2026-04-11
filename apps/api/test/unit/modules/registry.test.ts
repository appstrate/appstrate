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

  it("returns empty array when APPSTRATE_MODULES is unset or empty", () => {
    delete process.env.APPSTRATE_MODULES;
    expect(getModuleRegistry()).toEqual([]);
    process.env.APPSTRATE_MODULES = "";
    expect(getModuleRegistry()).toEqual([]);
  });

  it("parses comma-separated specifiers, trims whitespace, drops empty segments", () => {
    process.env.APPSTRATE_MODULES = " @appstrate/cloud , @acme/analytics ,,";
    expect(getModuleRegistry()).toEqual(["@appstrate/cloud", "@acme/analytics"]);
  });
});
