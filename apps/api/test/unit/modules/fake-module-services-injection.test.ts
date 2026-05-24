// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { AppstrateModule, ModuleInitContext } from "@appstrate/core/module";
import { buildModuleInitContext } from "../../../src/lib/modules/registry.ts";
import { loadModulesFromInstances, resetModules } from "../../../src/lib/modules/module-loader.ts";

/**
 * End-to-end check that a module actually *receives* a populated
 * `ctx.services` at `init()` time and can invoke representative services.
 *
 * The wiring test (`platform-services.test.ts`) asserts the builder's output
 * shape; this test exercises the real loader → init → service-call path a
 * third-party module would take. If the loader ever stops threading `ctx` or
 * loses the `services` field, this test fails immediately.
 */
describe("Module loader — ctx.services injection end-to-end", () => {
  let capturedCtx: ModuleInitContext | null = null;
  let capturedServices: ModuleInitContext["services"] | null = null;

  const fakeModule: AppstrateModule = {
    manifest: {
      id: "test-fake-services-injection",
      name: "Fake module (services injection test)",
      version: "0.0.0",
    },
    async init(ctx) {
      capturedCtx = ctx;
      capturedServices = ctx.services;
    },
  };

  beforeAll(async () => {
    resetModules();
    const ctx = buildModuleInitContext();
    await loadModulesFromInstances([fakeModule], ctx);
  });

  afterAll(() => {
    resetModules();
  });

  it("receives a populated ModuleInitContext at init", () => {
    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.appUrl).toEqual(expect.any(String));
    expect(capturedCtx!.services).toBeDefined();
  });

  // Note: the exhaustive namespace+method-shape contract is asserted by
  // `platform-services.test.ts` (the published PlatformServices regression
  // net). This file deliberately covers only the loader → init → service-call
  // path, so it doesn't duplicate that namespace-existence sweep.

  it("allows the module to invoke pure services that touch no infra", () => {
    // `env.hasRedis()` / `env.hasExternalDb()` are synchronous, side-effect
    // free, and return booleans regardless of tier. A module using them to
    // branch on deployment topology (e.g. skip a scheduled worker when
    // Redis is absent) would exercise this exact call path.
    const s = capturedServices!;
    expect(typeof s.env.hasRedis()).toBe("boolean");
    expect(typeof s.env.hasExternalDb()).toBe("boolean");

    // `packages.isInlineShadow` is a synchronous pure predicate — safe to
    // call from any module without touching the DB.
    expect(s.packages.isInlineShadow("@inline/anything")).toBe(true);
    expect(s.packages.isInlineShadow("@scope/real-pkg")).toBe(false);
  });

  it("allows the module to look itself up via services.modules.get", () => {
    // After init, the module is registered in the loader's map — a
    // representative cross-module coordination path.
    const s = capturedServices!;
    const found = s.modules.get("test-fake-services-injection");
    expect(found).not.toBeNull();
    expect(found?.manifest.id).toBe("test-fake-services-injection");
  });
});
