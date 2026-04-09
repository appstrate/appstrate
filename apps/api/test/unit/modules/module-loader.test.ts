// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, mock } from "bun:test";
import {
  loadModulesFromInstances,
  getModule,
  getModules,
  getModulePublicPaths,
  registerModuleRoutes,
  applyModuleAppConfig,
  callHook,
  getHookValue,
  hasHook,
  shutdownModules,
  resetModules,
} from "../../../src/lib/modules/module-loader.ts";
import type { AppstrateModule, ModuleInitContext } from "@appstrate/core/module";
import { SkipModuleError } from "@appstrate/core/module";
import type { AppConfig } from "@appstrate/shared-types";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("module-loader", () => {
  beforeEach(() => {
    resetModules();
  });

  describe("loadModulesFromInstances", () => {
    it("loads a module successfully", async () => {
      const mod = mockModule("alpha");
      await loadModulesFromInstances([mod], mockCtx());
      expect(getModule("alpha")).toBe(mod);
    });

    it("calls init() with the provided context", async () => {
      const initFn = mock(async (_ctx: ModuleInitContext) => {});
      const mod = mockModule("beta", { init: initFn });
      const ctx = mockCtx();
      await loadModulesFromInstances([mod], ctx);
      expect(initFn).toHaveBeenCalledTimes(1);
      expect(initFn).toHaveBeenCalledWith(ctx);
    });

    it("returns null for unknown module IDs", async () => {
      await loadModulesFromInstances([], mockCtx());
      expect(getModule("nonexistent")).toBeNull();
    });

    it("returns all loaded modules in init order", async () => {
      const a = mockModule("a");
      const b = mockModule("b");
      await loadModulesFromInstances([a, b], mockCtx());
      const ids = Array.from(getModules().keys());
      expect(ids).toEqual(["a", "b"]);
    });

    it("skips module on SkipModuleError", async () => {
      const mod = mockModule("skipped", {
        async init() {
          throw new SkipModuleError("not available");
        },
      });
      await loadModulesFromInstances([mod], mockCtx());
      expect(getModule("skipped")).toBeNull();
    });

    it("throws on non-SkipModuleError", async () => {
      const mod = mockModule("broken", {
        async init() {
          throw new Error("fatal");
        },
      });
      await expect(loadModulesFromInstances([mod], mockCtx())).rejects.toThrow("fatal");
    });

    it("is idempotent — second call is no-op", async () => {
      const initFn = mock(async () => {});
      const mod = mockModule("once", { init: initFn });
      await loadModulesFromInstances([mod], mockCtx());
      await loadModulesFromInstances([mod], mockCtx());
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
      await loadModulesFromInstances([a, b], mockCtx());
      expect(initOrder).toEqual(["b", "a"]);
    });

    it("throws on circular dependency", async () => {
      const a = mockModule("x", {
        manifest: { id: "x", name: "X", version: "1.0.0", dependencies: ["y"] },
      });
      const b = mockModule("y", {
        manifest: { id: "y", name: "Y", version: "1.0.0", dependencies: ["x"] },
      });
      await expect(loadModulesFromInstances([a, b], mockCtx())).rejects.toThrow(
        "Circular module dependency",
      );
    });

    it("ignores dependencies not in the module set", async () => {
      const a = mockModule("a", {
        manifest: { id: "a", name: "A", version: "1.0.0", dependencies: ["missing"] },
      });
      await loadModulesFromInstances([a], mockCtx());
      expect(getModule("a")).toBe(a);
    });
  });

  describe("getModulePublicPaths", () => {
    it("collects public paths from all loaded modules", async () => {
      const a = mockModule("a", { publicPaths: ["/api/a/hook"] });
      const b = mockModule("b", { publicPaths: ["/api/b/hook1", "/api/b/hook2"] });
      await loadModulesFromInstances([a, b], mockCtx());
      expect(getModulePublicPaths()).toEqual(["/api/a/hook", "/api/b/hook1", "/api/b/hook2"]);
    });

    it("returns empty array when no modules loaded", async () => {
      await loadModulesFromInstances([], mockCtx());
      expect(getModulePublicPaths()).toEqual([]);
    });
  });

  describe("registerModuleRoutes", () => {
    it("calls registerRoutes on each module", async () => {
      const routeFn = mock((_app: unknown) => {});
      const mod = mockModule("routed", { registerRoutes: routeFn });
      await loadModulesFromInstances([mod], mockCtx());

      const fakeApp = {};
      registerModuleRoutes(fakeApp);
      expect(routeFn).toHaveBeenCalledTimes(1);
      expect(routeFn).toHaveBeenCalledWith(fakeApp);
    });
  });

  describe("applyModuleAppConfig", () => {
    it("deep-merges module config overlays", async () => {
      const mod = mockModule("ext", {
        extendAppConfig: (base) => ({
          ...base,
          platform: "cloud",
          features: { ...(base.features as Record<string, boolean>), billing: true },
        }),
      });
      await loadModulesFromInstances([mod], mockCtx());

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
      expect(result.features.models).toBe(true);
    });
  });

  describe("agnostic hooks", () => {
    it("callHook returns undefined when no module provides the hook", async () => {
      await loadModulesFromInstances([], mockCtx());
      const result = await callHook("nonexistent");
      expect(result).toBeUndefined();
    });

    it("callHook delegates to the first module providing the hook", async () => {
      const mod = mockModule("hooked", {
        hooks: {
          myHook: async (x: number) => x * 2,
        },
      });
      await loadModulesFromInstances([mod], mockCtx());
      const result = await callHook<number>("myHook", 5);
      expect(result).toBe(10);
    });

    it("getHookValue returns null when no module provides the hook", async () => {
      await loadModulesFromInstances([], mockCtx());
      expect(getHookValue("missing")).toBeNull();
    });

    it("getHookValue returns value from the first module", async () => {
      class MyError extends Error {}
      const mod = mockModule("errors", {
        hooks: { getErrorClass: () => MyError },
      });
      await loadModulesFromInstances([mod], mockCtx());
      expect(getHookValue<typeof MyError>("getErrorClass")).toBe(MyError);
    });

    it("hasHook returns false when no module provides the hook", async () => {
      await loadModulesFromInstances([], mockCtx());
      expect(hasHook("missing")).toBe(false);
    });

    it("hasHook returns true when a module provides the hook", async () => {
      const mod = mockModule("provider", {
        hooks: { myHook: () => {} },
      });
      await loadModulesFromInstances([mod], mockCtx());
      expect(hasHook("myHook")).toBe(true);
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
      await loadModulesFromInstances([a, b], mockCtx());

      await shutdownModules();
      expect(order).toEqual(["b", "a"]);
    });

    it("clears all state after shutdown", async () => {
      const mod = mockModule("temp");
      await loadModulesFromInstances([mod], mockCtx());
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
      await loadModulesFromInstances([mod], mockCtx());
      await expect(shutdownModules()).resolves.toBeUndefined();
    });
  });
});
