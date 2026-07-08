// SPDX-License-Identifier: Apache-2.0

/**
 * Pins the OSS-mode boot contract for `loadModules`:
 *
 *   - the default registry (`MODULES` unset) is the OSS module set
 *     (oidc, webhooks, core-providers, @appstrate/module-codex,
 *     @appstrate/module-claude-code) and never attempts to dynamically
 *     import `@appstrate/cloud`. An OSS install without the private
 *     cloud package on disk MUST boot cleanly.
 *   - when a non-builtin specifier is listed but the npm package is not
 *     installed, the loader surfaces a wrapped error mentioning the
 *     specifier name (so operators see "Module \"@appstrate/cloud\" could
 *     not be loaded" instead of a raw ESM resolution stack trace).
 *
 * The latter is the OSS/Cloud contract from CLAUDE.md: the platform
 * should fail fast with a clear message rather than crash mysteriously
 * when a cloud-only deployment is misconfigured.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import { loadModules, resetModules } from "../../../src/lib/modules/module-loader.ts";
import { getModuleRegistry } from "../../../src/lib/modules/registry.ts";
import type { ModuleInitContext } from "@appstrate/core/module";

/**
 * `getModuleRegistry` reads `MODULES` through the cached `getEnv()` snapshot,
 * so mutations of `process.env.MODULES` must flush the cache to be visible.
 */
function setModulesEnv(value: string | undefined): void {
  if (value === undefined) delete process.env.MODULES;
  else process.env.MODULES = value;
  _resetCacheForTesting();
}

function mockCtx(): ModuleInitContext {
  return {
    redisUrl: null,
    appUrl: "http://localhost:3000",
    getSendMail: async () => () => {},
    getOrgAdminEmails: async () => [],
    services: {} as ModuleInitContext["services"],
  };
}

describe("OSS-mode module loading", () => {
  beforeEach(() => {
    resetModules();
  });

  it("default registry is the OSS module set — cloud + subscription modules never auto-loaded", () => {
    const previous = process.env.MODULES;
    setModulesEnv(undefined);
    try {
      // Default: built-in OSS modules ONLY (API-key surface). The two
      // reference OAuth-subscription modules (@appstrate/module-codex,
      // @appstrate/module-claude-code) are OPT-IN — a personal subscription
      // powering a product is an operator-owned grey-zone, so the OSS default
      // ships neither. See docs/architecture/SUBSCRIPTION_COMPLIANCE.md.
      expect(getModuleRegistry()).toEqual([
        "oidc",
        "webhooks",
        "mcp",
        "core-providers",
        "@appstrate/module-chat",
      ]);
    } finally {
      setModulesEnv(previous);
    }
  });

  it("subscription modules load only when explicitly appended to MODULES", () => {
    const previous = process.env.MODULES;
    setModulesEnv(
      "oidc,webhooks,mcp,core-providers,@appstrate/module-codex,@appstrate/module-claude-code",
    );
    try {
      expect(getModuleRegistry()).toEqual([
        "oidc",
        "webhooks",
        "mcp",
        "core-providers",
        "@appstrate/module-codex",
        "@appstrate/module-claude-code",
      ]);
    } finally {
      setModulesEnv(previous);
    }
  });

  it("a MODULES list containing only known builtins resolves and does not reach for any npm package", () => {
    const previous = process.env.MODULES;
    setModulesEnv("oidc,webhooks,core-providers");
    try {
      const registry = getModuleRegistry();
      expect(registry).toEqual(["oidc", "webhooks", "core-providers"]);
      // Sanity: no entry looks like an npm-style scoped package (which
      // would force a dynamic import). With this minimal env the surface
      // is built-in module ids only.
      for (const id of registry) {
        expect(id.startsWith("@")).toBe(false);
      }
    } finally {
      setModulesEnv(previous);
    }
  });

  it("loadModules wraps a missing npm specifier in a clear error mentioning the specifier", async () => {
    // Use a name that cannot resolve under any node_modules layout —
    // it is neither a builtin (under apps/api/src/modules/) nor a
    // published package. The error message must surface the specifier
    // so operators can debug a bad MODULES env quickly.
    const bogus = "@appstrate/this-module-does-not-exist";
    let caught: unknown;
    try {
      await loadModules([bogus], mockCtx());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(bogus);
    expect((caught as Error).message.toLowerCase()).toContain("could not be loaded");
  });

  it("an empty registry boots successfully (zero-module deployment)", async () => {
    await loadModules([], mockCtx());
    // No throw, no modules loaded — useful for smoke-test deployments.
  });
});
