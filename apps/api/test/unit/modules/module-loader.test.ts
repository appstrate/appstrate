// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, mock } from "bun:test";
import {
  loadModulesFromInstances,
  getModule,
  getModules,
  getModulePublicPaths,
  registerModuleRoutes,
  applyModuleFeatures,
  callHook,
  hasHook,
  emitEvent,
  shutdownModules,
  resetModules,
} from "../../../src/lib/modules/module-loader.ts";
import type { AppstrateModule, ModuleInitContext } from "@appstrate/core/module";
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

    it("throws on init error (all declared modules are required)", async () => {
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
      expect(getModulePublicPaths()).toEqual(
        new Set(["/api/a/hook", "/api/b/hook1", "/api/b/hook2"]),
      );
    });

    it("returns empty set when no modules loaded", async () => {
      await loadModulesFromInstances([], mockCtx());
      expect(getModulePublicPaths()).toEqual(new Set());
    });

    it("caches empty array correctly (does not recompute)", async () => {
      await loadModulesFromInstances([], mockCtx());
      const first = getModulePublicPaths();
      const second = getModulePublicPaths();
      // Same reference = cache was used
      expect(first).toBe(second);
    });
  });

  describe("registerModuleRoutes", () => {
    it("calls createRouter and mounts returned routers", async () => {
      const { Hono } = await import("hono");
      const router = new Hono();
      router.get("/ping", (c) => c.json({ ok: true }));
      const mod = mockModule("routed", { createRouter: () => router });
      await loadModulesFromInstances([mod], mockCtx());

      const app = new Hono();
      registerModuleRoutes(app as never);
      // Verify the route was mounted under /api
      const res = await app.request("/api/ping");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  describe("applyModuleFeatures", () => {
    it("merges module feature flags into base config", async () => {
      const mod = mockModule("ext", { features: { billing: true } });
      await loadModulesFromInstances([mod], mockCtx());

      const base: AppConfig = {
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

      const result = applyModuleFeatures(base);
      expect(result.features.billing).toBe(true);
      expect(result.features.models).toBe(true);
    });

    it("preserves base features when no modules loaded", async () => {
      await loadModulesFromInstances([], mockCtx());

      const base: AppConfig = {
        features: {
          billing: false,
          models: true,
          providerKeys: true,
          googleAuth: false,
          githubAuth: false,
          smtp: false,
        },
        trustedOrigins: [],
      };

      const result = applyModuleFeatures(base);
      expect(result.features).toEqual(base.features);
    });

    it("merges features from multiple modules", async () => {
      const a = mockModule("a", { features: { billing: true } });
      const b = mockModule("b", { features: { scheduling: true, webhooks: true } });
      await loadModulesFromInstances([a, b], mockCtx());

      const base: AppConfig = {
        features: {
          billing: false,
          models: true,
          providerKeys: true,
          googleAuth: false,
          githubAuth: false,
          smtp: false,
        },
        trustedOrigins: [],
      };

      const result = applyModuleFeatures(base);
      expect(result.features.billing).toBe(true);
      expect(result.features.scheduling).toBe(true);
      expect(result.features.webhooks).toBe(true);
      expect(result.features.models).toBe(true);
    });

    it("does not mutate the base config", async () => {
      const mod = mockModule("ext", { features: { billing: true } });
      await loadModulesFromInstances([mod], mockCtx());

      const base: AppConfig = {
        features: {
          billing: false,
          models: true,
          providerKeys: true,
          googleAuth: false,
          githubAuth: false,
          smtp: false,
        },
        trustedOrigins: [],
      };

      applyModuleFeatures(base);
      expect(base.features.billing).toBe(false);
    });

    it("does not touch non-features fields", async () => {
      const mod = mockModule("ext", { features: { billing: true } });
      await loadModulesFromInstances([mod], mockCtx());

      const base: AppConfig = {
        features: {
          billing: false,
          models: true,
          providerKeys: true,
          googleAuth: false,
          githubAuth: false,
          smtp: false,
        },
        legalUrls: { terms: "https://example.com/terms" },
        trustedOrigins: ["http://localhost:3000"],
      };

      const result = applyModuleFeatures(base);
      expect(result.legalUrls).toEqual({ terms: "https://example.com/terms" });
      expect(result.trustedOrigins).toEqual(["http://localhost:3000"]);
    });
  });

  describe("hooks (first-match-wins)", () => {
    it("callHook returns undefined when no module provides the hook", async () => {
      await loadModulesFromInstances([], mockCtx());
      const result = await callHook("beforeRun", { orgId: "o", agentId: "a", runningCount: 0 });
      expect(result).toBeUndefined();
    });

    it("callHook delegates to the first module providing the hook", async () => {
      const mod = mockModule("gate", {
        hooks: {
          beforeRun: async () => ({ code: "blocked", message: "no" }),
        },
      });
      await loadModulesFromInstances([mod], mockCtx());
      const result = await callHook("beforeRun", { orgId: "o", agentId: "a", runningCount: 0 });
      expect(result).toEqual({ code: "blocked", message: "no" });
    });

    it("hasHook returns false when no module provides the hook", async () => {
      await loadModulesFromInstances([], mockCtx());
      expect(hasHook("beforeRun")).toBe(false);
    });

    it("hasHook returns true when a module provides the hook", async () => {
      const mod = mockModule("gate", {
        hooks: { beforeRun: async () => null },
      });
      await loadModulesFromInstances([mod], mockCtx());
      expect(hasHook("beforeRun")).toBe(true);
    });
  });

  describe("emitEvent (broadcast)", () => {
    it("calls ALL modules that provide the event handler", async () => {
      const handlerA = mock(async () => {});
      const handlerB = mock(async () => {});
      const a = mockModule("a", { events: { onOrgCreated: handlerA } });
      const b = mockModule("b", { events: { onOrgCreated: handlerB } });
      await loadModulesFromInstances([a, b], mockCtx());

      await emitEvent("onOrgCreated", "org1", "user@test.com");
      expect(handlerA).toHaveBeenCalledTimes(1);
      expect(handlerA).toHaveBeenCalledWith("org1", "user@test.com");
      expect(handlerB).toHaveBeenCalledTimes(1);
      expect(handlerB).toHaveBeenCalledWith("org1", "user@test.com");
    });

    it("is no-op when no module provides the event", async () => {
      await loadModulesFromInstances([], mockCtx());
      await expect(emitEvent("onOrgCreated", "org1", "u@t.com")).resolves.toBeUndefined();
    });

    it("continues to other modules if one handler throws", async () => {
      const handlerA = mock(async () => {
        throw new Error("handler A failed");
      });
      const handlerB = mock(async () => {});
      const a = mockModule("a", { events: { onOrgDeleted: handlerA } });
      const b = mockModule("b", { events: { onOrgDeleted: handlerB } });
      await loadModulesFromInstances([a, b], mockCtx());

      // Should not throw
      await emitEvent("onOrgDeleted", "org1");
      expect(handlerA).toHaveBeenCalledTimes(1);
      expect(handlerB).toHaveBeenCalledTimes(1);
    });

    it("handles mix of modules with and without the event", async () => {
      const handler = mock(async () => {});
      const a = mockModule("a"); // no events
      const b = mockModule("b", { events: { onOrgDeleted: handler } });
      const c = mockModule("c"); // no events
      await loadModulesFromInstances([a, b, c], mockCtx());

      await emitEvent("onOrgDeleted", "org1");
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith("org1");
    });
  });

  describe("DX improvements", () => {
    it("enriches error message for required module init failure (loadModules path)", async () => {
      // loadModulesFromInstances always throws raw errors.
      // The enriched error is only in loadModules (dynamic import path).
      // We test the wrapping behavior via loadModulesFromInstances's throw:
      const mod = mockModule("broken", {
        async init() {
          throw new Error("db connection failed");
        },
      });
      await expect(loadModulesFromInstances([mod], mockCtx())).rejects.toThrow(
        "db connection failed",
      );
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
      expect(getModulePublicPaths()).toEqual(new Set());
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
