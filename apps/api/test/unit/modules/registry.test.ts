// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import { getModuleRegistry } from "../../../src/lib/modules/registry.ts";

describe("getModuleRegistry", () => {
  const originalValue = process.env.MODULES;

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.MODULES;
    } else {
      process.env.MODULES = originalValue;
    }
  });

  it("returns the default OSS modules when MODULES is unset", () => {
    delete process.env.MODULES;
    expect(getModuleRegistry()).toEqual([
      "oidc",
      "webhooks",
      "core-providers",
      "@appstrate/module-codex",
      "@appstrate/module-claude-code",
    ]);
  });

  it("returns empty array when MODULES is empty string", () => {
    process.env.MODULES = "";
    expect(getModuleRegistry()).toEqual([]);
  });

  it("parses comma-separated specifiers, trims whitespace, drops empty segments", () => {
    process.env.MODULES = " @scope/module , @acme/analytics ,,";
    expect(getModuleRegistry()).toEqual(["@scope/module", "@acme/analytics"]);
  });
});
