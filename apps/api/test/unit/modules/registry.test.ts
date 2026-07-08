// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import { getModuleRegistry } from "../../../src/lib/modules/registry.ts";

/**
 * `getModuleRegistry` reads `MODULES` through the cached `getEnv()` snapshot
 * (single source for the default — see #513), so every `process.env.MODULES`
 * mutation must be followed by a cache flush to become visible.
 */
function setModulesEnv(value: string | undefined): void {
  if (value === undefined) delete process.env.MODULES;
  else process.env.MODULES = value;
  _resetCacheForTesting();
}

describe("getModuleRegistry", () => {
  const originalValue = process.env.MODULES;

  afterEach(() => {
    setModulesEnv(originalValue);
  });

  it("returns the default OSS modules when MODULES is unset (subscription modules opt-in)", () => {
    setModulesEnv(undefined);
    expect(getModuleRegistry()).toEqual([
      "oidc",
      "webhooks",
      "mcp",
      "core-providers",
      "@appstrate/module-chat",
    ]);
  });

  it("treats the empty string as unset (env getter coalesces — default set)", () => {
    // The env getter coalesces `""` → unset (compose `${VAR:-}` pattern);
    // `MODULES=none` is the only zero-module sentinel.
    setModulesEnv("");
    expect(getModuleRegistry()).toContain("oidc");
  });

  it("returns empty array for the MODULES=none sentinel", () => {
    setModulesEnv("none");
    expect(getModuleRegistry()).toEqual([]);
  });

  it("treats whitespace-padded none as the sentinel", () => {
    setModulesEnv(" none ");
    expect(getModuleRegistry()).toEqual([]);
  });

  it("parses comma-separated specifiers, trims whitespace, drops empty segments", () => {
    setModulesEnv(" @scope/module , @acme/analytics ,,");
    expect(getModuleRegistry()).toEqual(["@scope/module", "@acme/analytics"]);
  });
});
