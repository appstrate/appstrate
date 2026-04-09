// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, mock } from "bun:test";
import {
  loadModules,
  getModule,
  getModules,
  getModulePublicPaths,
  registerModuleRoutes,
  applyModuleAppConfig,
  shutdownModules,
  resetModules,
} from "../../../src/lib/modules/module-loader.ts";
import { SkipModuleError } from "../../../src/lib/modules/types.ts";
import type {
  AppstrateModule,
  ModuleInitContext,
  ModuleEntry,
} from "../../../src/lib/modules/types.ts";
import type { AppConfig } from "@appstrate/shared-types";
import { Hono } from "hono";
import type { AppEnv } from "../../../src/types/index.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mockModule(id: string, overrides: Partial<AppstrateModule> = {}): AppstrateModule {
  return {
    manifest: { id, name: id, version: "1.0.0" },
    async init() {},
    ...overrides,
  };
}

function mockCtx(): ModuleInitContext {
  return {
    databaseUrl: null,
    redisUrl: null,
    appUrl: "http://localhost:3000",
    isEmbeddedDb: true,
    getSendMail: async () => () => {},
    getOrgAdminEmails: async () => [],
    registerEmailOverrides: () => {},
    setBeforeSignupHook: () => {},
  };
}

function entry(mod: AppstrateModule, required?: boolean): ModuleEntry {
  return { module: mod, required };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("module-loader", () => {
  beforeEach(() => {
    resetModules();
  });

  describe("loadModules", () => {
    it("loads a static module successfully", async () => {
      const mod = mockModule("alpha");
      await loadModules([entry(mod)], mockCtx());
      expect(getModule("alpha")).toBe(mod);
    });

    it("calls init() with the provided context", async () => {
      const initFn = mock(async (_ctx: ModuleInitContext) => {});
      const mod = mockModule("beta", { init: initFn });
      const ctx = mockCtx();
      await loadModules([entry(mod)], ctx);
      expect(initFn).toHaveBeenCalledTimes(1);
      expect(initFn).toHaveBeenCalledWith(ctx);
    });

    it("returns null for unknown module IDs", async () => {
      await loadModules([], mockCtx());
      expect(getModule("nonexistent")).toBeNull();
    });

    it("returns all loaded modules in init order", async () => {
      const a = mockModule("a");
      const b = mockModule("b");
      await loadModules([entry(a), entry(b)], mockCtx());
      const ids = Array.from(getModules().keys());
      expect(ids).toEqual(["a", "b"]);
    });

    it("skips module on SkipModuleError", async () => {
      const mod = mockModule("skipped", {
        async init() {
          throw new SkipModuleError("not available");
        },
      });
      await loadModules([entry(mod)], mockCtx());
      expect(getModule("skipped")).toBeNull();
    });

    it("throws on non-SkipModuleError from required module", async () => {
      const mod = mockModule("broken", {
        async init() {
          throw new Error("fatal");
        },
      });
      await expect(loadModules([entry(mod, true)], mockCtx())).rejects.toThrow("fatal");
    });

    it("skips non-required module on init error", async () => {
      const mod = mockModule("flaky", {
        async init() {
          throw new Error("oops");
        },
      });
      await loadModules([entry(mod)], mockCtx());
      expect(getModule("flaky")).toBeNull();
    });

    it("is idempotent — second call is no-op", async () => {
      const initFn = mock(async () => {});
      const mod = mockModule("once", { init: initFn });
      await loadModules([entry(mod)], mockCtx());
      await loadModules([entry(mod)], mockCtx());
      expect(initFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("topological sort", () => {
    it("sorts by dependencies — B before A when A depends on B", async () => {
      const initOrder: string[] = [];
      const a = mockModule("a", {
        manifest: { id: "a", name: "A", version: "1.0.0", dependencies: ["b"] },
        async init() {
          initOrder.push("a");
        },
      });
      const b = mockModule("b", {
        async init() {
          initOrder.push("b");
        },
      });
      // Deliberately pass a before b
      await loadModules([entry(a), entry(b)], mockCtx());
      expect(initOrder).toEqual(["b", "a"]);
    });

    it("throws on circular dependency", async () => {
      const a = mockModule("x", {
        manifest: { id: "x", name: "X", version: "1.0.0", dependencies: ["y"] },
      });
      const b = mockModule("y", {
        manifest: { id: "y", name: "Y", version: "1.0.0", dependencies: ["x"] },
      });
      await expect(loadModules([entry(a), entry(b)], mockCtx())).rejects.toThrow(
        "Circular module dependency",
      );
    });

    it("ignores dependencies not in the module set", async () => {
      const a = mockModule("a", {
        manifest: { id: "a", name: "A", version: "1.0.0", dependencies: ["missing"] },
      });
      await loadModules([entry(a)], mockCtx());
      expect(getModule("a")).toBe(a);
    });
  });

  describe("getModulePublicPaths", () => {
    it("collects public paths from all loaded modules", async () => {
      const a = mockModule("a", { publicPaths: ["/api/a/hook"] });
      const b = mockModule("b", { publicPaths: ["/api/b/hook1", "/api/b/hook2"] });
      await loadModules([entry(a), entry(b)], mockCtx());
      expect(getModulePublicPaths()).toEqual(["/api/a/hook", "/api/b/hook1", "/api/b/hook2"]);
    });

    it("returns empty array when no modules loaded", async () => {
      await loadModules([], mockCtx());
      expect(getModulePublicPaths()).toEqual([]);
    });
  });

  describe("registerModuleRoutes", () => {
    it("calls registerRoutes on each module", async () => {
      const routeFn = mock((_app: Hono<AppEnv>) => {});
      const mod = mockModule("routed", { registerRoutes: routeFn });
      await loadModules([entry(mod)], mockCtx());

      const app = new Hono<AppEnv>();
      registerModuleRoutes(app);
      expect(routeFn).toHaveBeenCalledTimes(1);
      expect(routeFn).toHaveBeenCalledWith(app);
    });
  });

  describe("applyModuleAppConfig", () => {
    it("deep-merges module config overlays", async () => {
      const mod = mockModule("ext", {
        extendAppConfig: (base) => ({
          platform: "cloud",
          features: { ...base.features, billing: true },
        }),
      });
      await loadModules([entry(mod)], mockCtx());

      const base: AppConfig = {
        platform: "oss",
        features: {
          billing: false,
          models: true,
          providerKeys: true,
          googleAuth: false,
          githubAuth: false,
          smtp: false,
        },
        trustedOrigins: ["http://localhost:3000"],
      };

      const result = applyModuleAppConfig(base);
      expect(result.platform).toBe("cloud");
      expect(result.features.billing).toBe(true);
      expect(result.features.models).toBe(true); // preserved from base
    });
  });

  describe("shutdownModules", () => {
    it("calls shutdown in reverse init order", async () => {
      const order: string[] = [];
      const a = mockModule("a", {
        async shutdown() {
          order.push("a");
        },
      });
      const b = mockModule("b", {
        async shutdown() {
          order.push("b");
        },
      });
      await loadModules([entry(a), entry(b)], mockCtx());

      await shutdownModules();
      expect(order).toEqual(["b", "a"]);
    });

    it("clears all state after shutdown", async () => {
      const mod = mockModule("temp");
      await loadModules([entry(mod)], mockCtx());
      await shutdownModules();
      expect(getModule("temp")).toBeNull();
      expect(getModulePublicPaths()).toEqual([]);
    });

    it("does not throw if a module shutdown fails", async () => {
      const mod = mockModule("crashy", {
        async shutdown() {
          throw new Error("boom");
        },
      });
      await loadModules([entry(mod)], mockCtx());
      await expect(shutdownModules()).resolves.toBeUndefined();
    });
  });
});
