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
    applyMigrations: async () => {},
    getSendMail: async () => () => {},
    getOrgAdminEmails: async () => [],
  };
}

const baseConfig: AppConfig = {
  features: {
    billing: false,
    webhooks: false,
    googleAuth: false,
    githubAuth: false,
    smtp: false,
  },
  trustedOrigins: [],
};

describe("module-loader", () => {
  beforeEach(() => {
    resetModules();
  });

  describe("loadModulesFromInstances", () => {
    it("loads a module and calls init with the provided context", async () => {
      const initFn = mock(async (_ctx: ModuleInitContext) => {});
      const mod = mockModule("alpha", { init: initFn });
      const ctx = mockCtx();
      await loadModulesFromInstances([mod], ctx);
      expect(getModule("alpha")).toBe(mod);
      expect(initFn).toHaveBeenCalledWith(ctx);
    });

    it("returns null for unknown module IDs", async () => {
      await loadModulesFromInstances([], mockCtx());
      expect(getModule("nonexistent")).toBeNull();
    });

    it("exposes loaded modules in init order", async () => {
      await loadModulesFromInstances([mockModule("a"), mockModule("b")], mockCtx());
      expect(Array.from(getModules().keys())).toEqual(["a", "b"]);
    });

    it("throws on init error (all declared modules are required)", async () => {
      const mod = mockModule("broken", {
        async init() {
          throw new Error("fatal");
        },
      });
      await expect(loadModulesFromInstances([mod], mockCtx())).rejects.toThrow("fatal");
    });

    it("is idempotent — second call is a no-op", async () => {
      const initFn = mock(async () => {});
      const mod = mockModule("once", { init: initFn });
      await loadModulesFromInstances([mod], mockCtx());
      await loadModulesFromInstances([mod], mockCtx());
      expect(initFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("topological sort", () => {
    it("sorts by dependencies — B before A when A depends on B", async () => {
      const order: string[] = [];
      const a = mockModule("a", {
        manifest: { id: "a", name: "A", version: "1.0.0", dependencies: ["b"] },
        async init() {
          order.push("a");
        },
      });
      const b = mockModule("b", {
        async init() {
          order.push("b");
        },
      });
      await loadModulesFromInstances([a, b], mockCtx());
      expect(order).toEqual(["b", "a"]);
    });

    it("throws on circular dependency", async () => {
      const x = mockModule("x", {
        manifest: { id: "x", name: "X", version: "1.0.0", dependencies: ["y"] },
      });
      const y = mockModule("y", {
        manifest: { id: "y", name: "Y", version: "1.0.0", dependencies: ["x"] },
      });
      await expect(loadModulesFromInstances([x, y], mockCtx())).rejects.toThrow(
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
  });

  describe("registerModuleRoutes", () => {
    it("mounts routers returned by createRouter under /api", async () => {
      const { Hono } = await import("hono");
      const router = new Hono();
      router.get("/ping", (c) => c.json({ ok: true }));
      const mod = mockModule("routed", { createRouter: () => router });
      await loadModulesFromInstances([mod], mockCtx());

      const app = new Hono();
      registerModuleRoutes(app as never);
      const res = await app.request("/api/ping");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  describe("applyModuleFeatures", () => {
    it("merges feature flags from every module without mutating base", async () => {
      const a = mockModule("a", { features: { billing: true } });
      const b = mockModule("b", { features: { webhooks: true } });
      await loadModulesFromInstances([a, b], mockCtx());

      const result = applyModuleFeatures(baseConfig);
      expect(result.features.billing).toBe(true);
      expect(result.features.webhooks).toBe(true);
      expect(baseConfig.features.billing).toBe(false); // unchanged
    });
  });

  describe("hooks (first-match-wins)", () => {
    it("callHook returns undefined when no module provides the hook", async () => {
      await loadModulesFromInstances([], mockCtx());
      const result = await callHook("beforeRun", { orgId: "o", agentId: "a", runningCount: 0 });
      expect(result).toBeUndefined();
    });

    it("callHook delegates to the first module providing the hook", async () => {
      const hookA = mock(async () => ({ code: "blocked", message: "no" }));
      const hookB = mock(async () => ({ code: "other", message: "ignored" }));
      const a = mockModule("a", { hooks: { beforeRun: hookA } });
      const b = mockModule("b", { hooks: { beforeRun: hookB } });
      await loadModulesFromInstances([a, b], mockCtx());

      const result = await callHook("beforeRun", { orgId: "o", agentId: "a", runningCount: 0 });
      expect(result).toEqual({ code: "blocked", message: "no" });
      expect(hookA).toHaveBeenCalledTimes(1);
      expect(hookB).toHaveBeenCalledTimes(0);
    });

    it("hasHook reflects whether any module provides the hook", async () => {
      await loadModulesFromInstances(
        [mockModule("gate", { hooks: { beforeRun: async () => null } })],
        mockCtx(),
      );
      expect(hasHook("beforeRun")).toBe(true);
      expect(hasHook("beforeSignup")).toBe(false);
    });

    it("callHook('afterRun') returns the metadata patch from the first matching module", async () => {
      const mod = mockModule("billing", {
        hooks: { afterRun: async () => ({ creditsUsed: 42 }) },
      });
      await loadModulesFromInstances([mod], mockCtx());

      const result = await callHook("afterRun", {
        orgId: "o",
        runId: "r",
        agentId: "a",
        applicationId: "app",
        status: "success",
        cost: 0.05,
        duration: 1234,
        modelSource: "system",
      });
      expect(result).toEqual({ creditsUsed: 42 });
    });

    it("callHook('afterRun') returns undefined when no module provides the hook", async () => {
      await loadModulesFromInstances([], mockCtx());

      const result = await callHook("afterRun", {
        orgId: "o",
        runId: "r",
        agentId: "a",
        applicationId: "app",
        status: "success",
        cost: 0,
        duration: 100,
        modelSource: null,
      });
      expect(result).toBeUndefined();
    });
  });

  describe("emitEvent (broadcast)", () => {
    it("calls every module that provides the event handler", async () => {
      const handlerA = mock(async () => {});
      const handlerB = mock(async () => {});
      const a = mockModule("a", { events: { onOrgCreate: handlerA } });
      const b = mockModule("b", { events: { onOrgCreate: handlerB } });
      await loadModulesFromInstances([a, b], mockCtx());

      await emitEvent("onOrgCreate", "org1", "user@test.com");
      expect(handlerA).toHaveBeenCalledWith("org1", "user@test.com");
      expect(handlerB).toHaveBeenCalledWith("org1", "user@test.com");
    });

    it("continues to other modules if one handler throws", async () => {
      const handlerA = mock(async () => {
        throw new Error("boom");
      });
      const handlerB = mock(async () => {});
      const a = mockModule("a", { events: { onOrgDelete: handlerA } });
      const b = mockModule("b", { events: { onOrgDelete: handlerB } });
      await loadModulesFromInstances([a, b], mockCtx());

      await emitEvent("onOrgDelete", "org1");
      expect(handlerA).toHaveBeenCalledTimes(1);
      expect(handlerB).toHaveBeenCalledTimes(1);
    });
  });

  describe("shutdownModules", () => {
    it("calls shutdown in reverse init order and clears state", async () => {
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
      expect(getModule("a")).toBeNull();
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
