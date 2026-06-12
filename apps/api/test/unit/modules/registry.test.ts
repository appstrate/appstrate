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

  it("returns the default OSS modules when MODULES is unset", () => {
    setModulesEnv(undefined);
    expect(getModuleRegistry()).toEqual([
      "oidc",
      "webhooks",
      "mcp",
      "core-providers",
      "@appstrate/module-codex",
      "@appstrate/module-claude-code",
    ]);
  });

  it("returns empty array when MODULES is empty string", () => {
    // NOTE: the env getter coalesces `""` → unset (compose `${VAR:-}`
    // pattern), so an empty string yields the DEFAULT module set — same
    // behavior an empty var has at boot.
    setModulesEnv("");
    expect(getModuleRegistry()).toEqual([
      "oidc",
      "webhooks",
      "mcp",
      "core-providers",
      "@appstrate/module-codex",
      "@appstrate/module-claude-code",
    ]);
  });

  it("parses comma-separated specifiers, trims whitespace, drops empty segments", () => {
    setModulesEnv(" @scope/module , @acme/analytics ,,");
    expect(getModuleRegistry()).toEqual(["@scope/module", "@acme/analytics"]);
  });
});
