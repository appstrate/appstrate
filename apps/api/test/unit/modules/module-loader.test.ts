// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, mock } from "bun:test";
import {
  loadModulesFromInstances,
  getModule,
  getModules,
  getModuleOidcScopes,
  getModulePublicPaths,
  registerModuleRoutes,
  applyModuleFeatures,
  callHook,
  hasHook,
  emitEvent,
  shutdownModules,
  resetModules,
  getModuleAuthStrategies,
  getModuleContributions,
} from "../../../src/lib/modules/module-loader.ts";
import type { AppstrateModule, ModuleInitContext, AuthStrategy } from "@appstrate/core/module";
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
    services: {} as ModuleInitContext["services"],
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
    it("mounts routers returned by createRouter at the HTTP origin root", async () => {
      // Modules declare full paths — the platform does NOT inject an /api
      // prefix. This lets a single module expose both `/api/*` business
      // endpoints AND RFC-specified root paths like `/.well-known/*` from
      // one router.
      const { Hono } = await import("hono");
      const router = new Hono();
      router.get("/api/ping", (c) => c.json({ ok: true, scope: "api" }));
      router.get("/.well-known/ping", (c) => c.json({ ok: true, scope: "root" }));
      const mod = mockModule("routed", { createRouter: () => router });
      await loadModulesFromInstances([mod], mockCtx());

      const app = new Hono();
      registerModuleRoutes(app as never);

      const apiRes = await app.request("/api/ping");
      expect(apiRes.status).toBe(200);
      expect(await apiRes.json()).toEqual({ ok: true, scope: "api" });

      const rootRes = await app.request("/.well-known/ping");
      expect(rootRes.status).toBe(200);
      expect(await rootRes.json()).toEqual({ ok: true, scope: "root" });
    });
  });

  describe("applyModuleFeatures", () => {
    it("merges feature flags from every module without mutating base", async () => {
      const a = mockModule("a", { features: { billing: true } });
      const b = mockModule("b", { features: { webhooks: true } });
      await loadModulesFromInstances([a, b], mockCtx());

      const result = await applyModuleFeatures(baseConfig);
      expect(result.features.billing).toBe(true);
      expect(result.features.webhooks).toBe(true);
      expect(baseConfig.features.billing).toBe(false); // unchanged
    });
  });

  describe("hooks (first-match-wins)", () => {
    it("callHook returns undefined when no module provides the hook", async () => {
      await loadModulesFromInstances([], mockCtx());
      const result = await callHook("beforeRun", { orgId: "o", packageId: "a", runningCount: 0 });
      expect(result).toBeUndefined();
    });

    it("callHook delegates to the first module providing the hook", async () => {
      const hookA = mock(async () => ({ code: "blocked", message: "no" }));
      const hookB = mock(async () => ({ code: "other", message: "ignored" }));
      const a = mockModule("a", { hooks: { beforeRun: hookA } });
      const b = mockModule("b", { hooks: { beforeRun: hookB } });
      await loadModulesFromInstances([a, b], mockCtx());

      const result = await callHook("beforeRun", { orgId: "o", packageId: "a", runningCount: 0 });
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
        packageId: "a",
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
        packageId: "a",
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

  // Guards the module-side of the zero-footprint invariant from CLAUDE.md:
  // with an empty module set, the loader contributes nothing — no module
  // routes mount, no module feature flags flip, no module hooks register, no
  // module public paths leak. Core routes/features/hooks (agents, runs, auth,
  // etc.) are unaffected and live outside the module system. This test only
  // exercises the module-loader surface; the full-boot zero-footprint check
  // is covered manually (see PR test plan).
  describe("empty module set contributes nothing", () => {
    it("registers no module routes, features, public paths, or hooks", async () => {
      const { Hono } = await import("hono");

      await loadModulesFromInstances([], mockCtx());

      expect(getModules().size).toBe(0);
      expect(getModulePublicPaths()).toEqual(new Set());

      // registerModuleRoutes is a no-op — it only mounts module-provided
      // routers. Core routers are wired separately in apps/api/src/index.ts
      // (and in the test harness) and are unaffected.
      const app = new Hono();
      registerModuleRoutes(app as never);
      const res = await app.request("/api/webhooks");
      expect(res.status).toBe(404);

      // applyModuleFeatures leaves base features untouched — only module
      // contributions are merged in.
      const merged = await applyModuleFeatures(baseConfig);
      expect(merged.features).toEqual(baseConfig.features);

      // No module-provided hooks. Core does not use the module hook system
      // for its own logic, so this strictly reflects the module surface.
      expect(hasHook("beforeRun")).toBe(false);
      expect(hasHook("afterRun")).toBe(false);
      expect(hasHook("beforeSignup")).toBe(false);

      // emitEvent is a silent no-op when no module listens — no handlers run
      // and no error propagates.
      await expect(
        emitEvent("onRunStatusChange", {
          orgId: "o",
          runId: "r",
          packageId: "a",
          applicationId: "app",
          status: "success",
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("getModuleOidcScopes", () => {
    it("returns empty array when no module contributes scopes", async () => {
      await loadModulesFromInstances([], mockCtx());
      expect(getModuleOidcScopes()).toEqual([]);
    });

    it("aggregates oidcScopes from every loaded module", async () => {
      await loadModulesFromInstances(
        [
          mockModule("chat", { oidcScopes: ["chat:read", "chat:write"] }),
          mockModule("billing", { oidcScopes: ["billing:read"] }),
        ],
        mockCtx(),
      );
      expect(getModuleOidcScopes().sort()).toEqual(["billing:read", "chat:read", "chat:write"]);
    });

    it("deduplicates repeated scopes", async () => {
      await loadModulesFromInstances(
        [
          mockModule("alpha", { oidcScopes: ["x:read"] }),
          mockModule("beta", { oidcScopes: ["x:read", "y:read"] }),
        ],
        mockCtx(),
      );
      expect(getModuleOidcScopes().sort()).toEqual(["x:read", "y:read"]);
    });

    it("excludes the OIDC module's own contributions (canonical vocabulary lives in scopes.ts)", async () => {
      await loadModulesFromInstances(
        [
          // A module with id "oidc" must not pollute the aggregator —
          // the OIDC module owns the built-in vocabulary directly.
          mockModule("oidc", { oidcScopes: ["should-be-ignored"] }),
          mockModule("chat", { oidcScopes: ["chat:read"] }),
        ],
        mockCtx(),
      );
      expect(getModuleOidcScopes()).toEqual(["chat:read"]);
    });
  });

  describe("getModuleAuthStrategies", () => {
    it("returns empty array in OSS mode (no modules loaded)", () => {
      // resetModules() in beforeEach ensures clean state
      expect(getModuleAuthStrategies()).toEqual([]);
    });

    it("flattens strategies from multiple modules in load order", async () => {
      const stratA: AuthStrategy = {
        id: "strat-a",
        async authenticate() {
          return null;
        },
      };
      const stratB1: AuthStrategy = {
        id: "strat-b1",
        async authenticate() {
          return null;
        },
      };
      const stratB2: AuthStrategy = {
        id: "strat-b2",
        async authenticate() {
          return null;
        },
      };
      await loadModulesFromInstances(
        [
          mockModule("a", { authStrategies: () => [stratA] }),
          mockModule("b", { authStrategies: () => [stratB1, stratB2] }),
        ],
        mockCtx(),
      );
      expect(getModuleAuthStrategies().map((s) => s.id)).toEqual([
        "strat-a",
        "strat-b1",
        "strat-b2",
      ]);
    });

    it("returns empty array after resetModules()", async () => {
      await loadModulesFromInstances(
        [
          mockModule("a", {
            authStrategies: () => [
              {
                id: "s1",
                async authenticate() {
                  return null;
                },
              },
            ],
          }),
        ],
        mockCtx(),
      );
      expect(getModuleAuthStrategies()).toHaveLength(1);
      resetModules();
      expect(getModuleAuthStrategies()).toEqual([]);
    });
  });

  describe("getModuleContributions", () => {
    it("returns empty shape in OSS mode (no modules loaded)", () => {
      expect(getModuleContributions()).toEqual({
        betterAuthPlugins: [],
        drizzleSchemas: {},
      });
    });

    it("flattens plugins + schemas from multiple modules in load order", async () => {
      const plugA = { id: "plug-a" };
      const plugB1 = { id: "plug-b1" };
      const plugB2 = { id: "plug-b2" };
      const tableA = { __table: "a" };
      const tableB = { __table: "b" };
      await loadModulesFromInstances(
        [
          mockModule("a", {
            betterAuthPlugins: () => [plugA],
            drizzleSchemas: () => ({ tableA }),
          }),
          mockModule("b", {
            betterAuthPlugins: () => [plugB1, plugB2],
            drizzleSchemas: () => ({ tableB }),
          }),
        ],
        mockCtx(),
      );
      const contributions = getModuleContributions();
      expect(contributions.betterAuthPlugins).toEqual([plugA, plugB1, plugB2]);
      expect(contributions.drizzleSchemas).toEqual({ tableA, tableB });
    });

    it("returns empty shape after resetModules()", async () => {
      await loadModulesFromInstances(
        [mockModule("a", { betterAuthPlugins: () => [{ id: "x" }] })],
        mockCtx(),
      );
      expect(getModuleContributions().betterAuthPlugins).toHaveLength(1);
      resetModules();
      expect(getModuleContributions()).toEqual({
        betterAuthPlugins: [],
        drizzleSchemas: {},
      });
    });
  });
});
