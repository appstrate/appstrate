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
import { loadModules, resetModules } from "../../../src/lib/modules/module-loader.ts";
import { getModuleRegistry } from "../../../src/lib/modules/registry.ts";
import type { ModuleInitContext } from "@appstrate/core/module";

function mockCtx(): ModuleInitContext {
  return {
    databaseUrl: null,
    redisUrl: null,
    appUrl: "http://localhost:3000",
    isEmbeddedDb: true,
    applyMigrations: async () => {},
    getSendMail: async () => () => {},
    getOrgAdminEmails: async () => [],
    services: {} as ModuleInitContext["services"],
  };
}

describe("OSS-mode module loading", () => {
  beforeEach(() => {
    resetModules();
  });

  it("default registry is the OSS module set — cloud is never auto-loaded", () => {
    const previous = process.env.MODULES;
    delete process.env.MODULES;
    try {
      // Defaults: built-in OSS modules + the two reference OAuth-provider
      // modules (@appstrate/module-codex for ChatGPT/Codex,
      // @appstrate/module-claude-code for Claude Pro/Max/Team).
      expect(getModuleRegistry()).toEqual([
        "oidc",
        "webhooks",
        "core-providers",
        "@appstrate/module-codex",
        "@appstrate/module-claude-code",
      ]);
    } finally {
      if (previous !== undefined) process.env.MODULES = previous;
    }
  });

  it("a MODULES list containing only known builtins resolves and does not reach for any npm package", () => {
    const previous = process.env.MODULES;
    process.env.MODULES = "oidc,webhooks,core-providers";
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
      if (previous === undefined) delete process.env.MODULES;
      else process.env.MODULES = previous;
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
