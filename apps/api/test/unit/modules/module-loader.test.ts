// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetCacheForTesting } from "@appstrate/env";
import { CORE_VERSION } from "@appstrate/core/module";
import { logger } from "../../../src/lib/logger.ts";
import {
  _coreRangeFromPackageJson,
  loadModules,
  loadModulesFromInstances,
  getModules,
  getModulePublicPaths,
  registerModuleRoutes,
  applyModuleFeatures,
  callHook,
  callAllHooks,
  hasHook,
  emitEvent,
  shutdownModules,
  resetModules,
  getModuleAuthStrategies,
  getModuleContributions,
  getModuleModelProviders,
} from "../../../src/lib/modules/module-loader.ts";
import type {
  AppstrateModule,
  ModelProviderDefinition,
  ModuleInitContext,
  AuthStrategy,
} from "@appstrate/core/module";
import type { AppConfig } from "@appstrate/shared-types";

// The fictitious resources these tests contribute. `ModulePermissionContribution`
// is now typed against this augmentation, so a test module can no longer invent
// a resource the type system has never heard of — the same guard a real module
// gets. Deliberately-invalid inputs below are cast, which is exactly the point:
// reaching them now requires opting out of the types.
declare module "@appstrate/core/permissions" {
  interface ModuleResources {
    tasks: "read" | "write";
    internal: "sweep";
    "module-billing": "view";
    shared: "read";
  }
}

function mockModule(id: string, overrides: Partial<AppstrateModule> = {}): AppstrateModule {
  return {
    manifest: { id, name: id, version: "1.0.0" },
    async init() {},
    ...overrides,
  };
}

/**
 * Write a fixture package under `root` and return the specifier pointing at it
 * — an absolute path, which Bun resolves syntactically (no `node_modules`
 * lookup, which would resolve relative to this file rather than to `root`).
 */
async function writeFixturePackage(
  root: string,
  name: string,
  pkg: Record<string, unknown>,
  extraFiles: Record<string, string> = {},
): Promise<string> {
  const dir = join(root, name);
  await Bun.write(join(dir, "package.json"), JSON.stringify(pkg));
  for (const [rel, body] of Object.entries(extraFiles)) {
    await Bun.write(join(dir, rel), body);
  }
  return dir;
}

function mockCtx(): ModuleInitContext {
  return {
    redisUrl: null,
    appUrl: "http://localhost:3000",
    getSendMail: async () => () => {},
    getOrgAdminEmails: async () => [],
    getOrgName: async () => null,
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
    signupDisabled: false,
    orgCreationDisabled: false,
    bootstrapTokenPending: false,
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
      expect(getModules().get("alpha")).toBe(mod);
      expect(initFn).toHaveBeenCalledWith(ctx);
    });

    it("returns null for unknown module IDs", async () => {
      await loadModulesFromInstances([], mockCtx());
      expect(getModules().get("nonexistent")).toBeUndefined();
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

  /**
   * The export shape a module is loaded from — the DEFAULT export, and only
   * that one.
   *
   * A named `appstrateModule` export was accepted beside it and had never had a
   * producer; it is gone. Asserted rather than deleted in silence, because a
   * reintroduced `?? raw.appstrateModule` is invisible: it would typecheck and
   * pass every other test here while quietly restoring two names for one
   * contract. The retired shape must FAIL, and the failure must tell the author
   * which shape to write instead of blaming a manifest that is fine.
   */
  describe("module export shape", () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "appstrate-module-shape-"));
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    /** A loadable package whose entry file is `body`, verbatim. */
    async function entryFixture(name: string, body: string): Promise<string> {
      return writeFixturePackage(
        root,
        name,
        { name, type: "module", main: "index.js" },
        { "index.js": body },
      );
    }

    const CONTRACT = `{ manifest: { id: "shaped", name: "shaped", version: "1.0.0" }, init: async () => {} }`;

    it("rejects a module exposing only a named `appstrateModule` export", async () => {
      const specifier = await entryFixture(
        "named-only",
        `export const appstrateModule = ${CONTRACT};`,
      );
      await expect(loadModules([specifier], mockCtx())).rejects.toThrow("no default export");
      expect(getModules().size).toBe(0);
    });

    it("names the required shape in the refusal", async () => {
      const specifier = await entryFixture(
        "named-only-2",
        `export const appstrateModule = ${CONTRACT};`,
      );
      await expect(loadModules([specifier], mockCtx())).rejects.toThrow("export default");
    });

    it("loads the same contract when it is the default export", async () => {
      const specifier = await entryFixture("default-export", `export default ${CONTRACT};`);
      await loadModules([specifier], mockCtx());
      expect(getModules().has("shaped")).toBe(true);
    });
  });

  /**
   * The module→platform half of the contract (#973): an out-of-tree module
   * built against an older core is invisible to `tsc`, and a stale caller of a
   * platform service fails SILENTLY (core 6.0.0 made
   * `checkUsageAllowed.subscription` required — a 5.x caller omitting it reads
   * a subscription turn as platform-funded). Ranges are derived from
   * `CORE_VERSION` so the expectations survive the next major bump.
   *
   * Driven through `loadModules()` against real on-disk packages, because that
   * is the only entry point that can gate anything: the declared range comes
   * from the module's own `package.json`, and an instance-loaded module carries
   * no specifier to read one from.
   */
  describe("core version contract", () => {
    const currentRange = `^${CORE_VERSION}`;
    const staleRange = `^${Number(CORE_VERSION.split(".")[0]) - 1}.0.0`;
    const originalEnforce = process.env.MODULE_CONTRACT_ENFORCE;
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "appstrate-module-contract-"));
      // Start every test from an unset var so "the default" is whatever the
      // Zod schema says, not whatever the ambient environment happens to
      // carry (Bun auto-loads `.env`).
      delete process.env.MODULE_CONTRACT_ENFORCE;
      _resetCacheForTesting();
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
      if (originalEnforce === undefined) delete process.env.MODULE_CONTRACT_ENFORCE;
      else process.env.MODULE_CONTRACT_ENFORCE = originalEnforce;
      _resetCacheForTesting();
    });

    /**
     * A loadable module package: a `package.json` declaring `range` (omitted
     * when null) plus an entry file default-exporting the module contract.
     * Each test gets a fresh `root`, so two fixtures sharing an id are still
     * distinct paths and never collide in the import cache.
     */
    async function moduleFixture(id: string, range: string | null): Promise<string> {
      const quoted = JSON.stringify(id);
      return writeFixturePackage(
        root,
        id,
        {
          name: id,
          type: "module",
          main: "index.js",
          ...(range === null ? {} : { dependencies: { "@appstrate/core": range } }),
        },
        {
          "index.js":
            `export default { manifest: { id: ${quoted}, name: ${quoted}, version: "1.0.0" }, ` +
            `init: async () => {} };`,
        },
      );
    }

    /**
     * Pin the policy explicitly, so the test that proves a branch does not
     * silently ride on the schema default — the default is proven by its own
     * test, with the var left unset.
     */
    function setEnforce(policy: "fail" | "warn"): void {
      process.env.MODULE_CONTRACT_ENFORCE = policy;
      _resetCacheForTesting();
    }

    it("refuses a module whose range excludes the running core, no env set", async () => {
      // The gate only earns its keep if an operator gets it without opting in,
      // so the refusal is pinned against the SHIPPED DEFAULT (var deleted in
      // `beforeEach`), not against an explicit policy. Both versions must
      // appear in the message: the operator has to see what the module wants
      // AND what this platform ships to know which side to bump.
      const promise = loadModules([await moduleFixture("stale", staleRange)], mockCtx());
      await expect(promise).rejects.toThrow(staleRange);
      expect(getModules().size).toBe(0);
    });

    it("names the running core version in the failure", async () => {
      const promise = loadModules([await moduleFixture("stale", staleRange)], mockCtx());
      await expect(promise).rejects.toThrow(CORE_VERSION);
    });

    it("refuses under an explicit `fail`", async () => {
      setEnforce("fail");
      const promise = loadModules([await moduleFixture("stale", staleRange)], mockCtx());
      await expect(promise).rejects.toThrow(staleRange);
      expect(getModules().size).toBe(0);
    });

    it("offers the escape hatch in the refusal", async () => {
      // A refusal that only says "no" strands an operator who cannot republish
      // the module right now: the way to boot anyway has to be IN the failure.
      const promise = loadModules([await moduleFixture("stale", staleRange)], mockCtx());
      await expect(promise).rejects.toThrow("MODULE_CONTRACT_ENFORCE=warn");
    });

    it("logs the mismatch and boots under `warn`", async () => {
      setEnforce("warn");
      const warn = spyOn(logger, "warn");
      try {
        await loadModules([await moduleFixture("stale", staleRange)], mockCtx());
        // The escape hatch must stay loud: booting anyway is only defensible
        // if the operator can see, in the logs, exactly which module is stale.
        expect(getModules().has("stale")).toBe(true);
        const mismatchLine = warn.mock.calls
          .map(([msg]) => String(msg))
          .find((msg) => msg.includes(staleRange) && msg.includes(CORE_VERSION));
        expect(mismatchLine).toBeDefined();
        // `warn` is an explicit opt-in, so the operator reading this line has
        // already set the var. Telling them to set it is a wrong instruction —
        // the line must report what is being ACCEPTED, not prescribe a remedy
        // that is already in effect. (Asserted case-insensitively so a reworded
        // "Set …"/"set …" cannot slip the check.)
        expect(mismatchLine?.toLowerCase()).not.toContain("set module_contract_enforce");
      } finally {
        warn.mockRestore();
      }
    });

    it("loads a module whose declared range is satisfied by the running core", async () => {
      await loadModules([await moduleFixture("current", currentRange)], mockCtx());
      expect(getModules().has("current")).toBe(true);
    });

    it("loads a module that declares no range, warning that nothing was verified", async () => {
      const warn = spyOn(logger, "warn");
      try {
        await loadModules([await moduleFixture("undeclared", null)], mockCtx());
        expect(getModules().has("undeclared")).toBe(true);
        // Unknown is a blind spot, not a fault — but the operator must be told
        // it IS a blind spot, otherwise a silent load reads as a green verdict.
        const warned = warn.mock.calls.some(([msg]) =>
          String(msg).includes("version contract unverified"),
        );
        expect(warned).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });

    it("loads an in-tree module (workspace protocol is gated by tsc, not semver)", async () => {
      await loadModules([await moduleFixture("in-tree", "workspace:*")], mockCtx());
      expect(getModules().has("in-tree")).toBe(true);
    });
  });

  /**
   * The range lookup itself, unit-tested on fixture packages: dep-kind
   * precedence and the "read the module's OWN package.json" rule. Absolute-path
   * specifiers cannot reproduce a bare specifier's `node_modules` lookup,
   * because resolution is relative to `module-loader.ts`, not to a temp
   * directory.
   */
  describe("_coreRangeFromPackageJson", () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "appstrate-core-range-"));
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const fixture = (
      name: string,
      pkg: Record<string, unknown>,
      extraFiles: Record<string, string> = {},
    ) => writeFixturePackage(root, name, pkg, extraFiles);

    it("prefers dependencies, then peerDependencies, then devDependencies", async () => {
      const all = await fixture("all", {
        dependencies: { "@appstrate/core": "^6.0.0" },
        peerDependencies: { "@appstrate/core": "^5.0.0" },
        devDependencies: { "@appstrate/core": "^4.0.0" },
      });
      const peer = await fixture("peer", {
        peerDependencies: { "@appstrate/core": "^5.0.0" },
        devDependencies: { "@appstrate/core": "^4.0.0" },
      });
      const dev = await fixture("dev", { devDependencies: { "@appstrate/core": "^4.0.0" } });

      expect(await _coreRangeFromPackageJson(all)).toBe("^6.0.0");
      expect(await _coreRangeFromPackageJson(peer)).toBe("^5.0.0");
      expect(await _coreRangeFromPackageJson(dev)).toBe("^4.0.0");
    });

    it("reads the module's own package.json, not a `dist/package.json` type marker", async () => {
      // A published module's entry commonly sits in `dist/` beside a
      // `{"type":"module"}` marker — a second package.json with no
      // `@appstrate/core` key. Resolving `<specifier>/package.json` lands on
      // the package root whatever the entry layout, so the module's own
      // declaration wins and the marker is never consulted.
      const dir = await fixture(
        "dist-marker",
        { main: "dist/index.js", dependencies: { "@appstrate/core": "^6.0.0" } },
        { "dist/package.json": '{"type":"module"}', "dist/index.js": "export const x = 1;" },
      );
      expect(await _coreRangeFromPackageJson(dir)).toBe("^6.0.0");
    });

    it("returns null when the package declares no @appstrate/core range", async () => {
      const dir = await fixture("silent", { dependencies: { hono: "^4.0.0" } });
      expect(await _coreRangeFromPackageJson(dir)).toBeNull();
    });

    it("returns null for an unresolvable specifier (unknown, never a crash)", async () => {
      expect(await _coreRangeFromPackageJson("@appstrate/module-does-not-exist")).toBeNull();
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

    it("throws when a declared dependency is not in the module set", async () => {
      // A declared dependency is a hard peer requirement: a dependent whose dep
      // isn't loaded cannot work (e.g. `chat` without `mcp`), so boot fails with
      // a clear config error rather than silently degrading.
      const a = mockModule("a", {
        manifest: { id: "a", name: "A", version: "1.0.0", dependencies: ["missing"] },
      });
      await expect(loadModulesFromInstances([a], mockCtx())).rejects.toThrow(
        'requires module "missing"',
      );
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
      const result = await callHook("beforeUsage", {
        orgId: "o",
        context: "run",
        packageId: "a",
        runningCount: 0,
        credentialSource: "system",
        executionPlane: "platform",
        timeoutSeconds: 300,
      });
      expect(result).toBeUndefined();
    });

    it("callHook delegates to the first module providing the hook", async () => {
      const hookA = mock(async () => ({ code: "blocked", message: "no" }));
      const hookB = mock(async () => ({ code: "other", message: "ignored" }));
      const a = mockModule("a", { hooks: { beforeUsage: hookA } });
      const b = mockModule("b", { hooks: { beforeUsage: hookB } });
      await loadModulesFromInstances([a, b], mockCtx());

      const result = await callHook("beforeUsage", {
        orgId: "o",
        context: "run",
        packageId: "a",
        runningCount: 0,
        credentialSource: "system",
        executionPlane: "platform",
        timeoutSeconds: 300,
      });
      expect(result).toEqual({ code: "blocked", message: "no" });
      expect(hookA).toHaveBeenCalledTimes(1);
      expect(hookB).toHaveBeenCalledTimes(0);
    });

    it("hasHook reflects whether any module provides the hook", async () => {
      await loadModulesFromInstances(
        [mockModule("gate", { hooks: { beforeUsage: async () => null } })],
        mockCtx(),
      );
      expect(hasHook("beforeUsage")).toBe(true);
      expect(hasHook("beforeSignup")).toBe(false);
    });

    it("callHook returns undefined when no module provides the hook", async () => {
      await loadModulesFromInstances([], mockCtx());

      const result = await callHook("beforeUsage", {
        orgId: "o",
        context: "run",
        packageId: "a",
        runningCount: 1,
        credentialSource: "system",
        executionPlane: "platform",
        timeoutSeconds: 300,
      });
      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // Broadcast dispatch. `beforeSignup` is a gate EVERY module must get to
  // veto — first-match-wins here would silently skip every module after the
  // first, a security control failing open with no error. The `callHook` /
  // `callAllHooks` signatures make that call unrepresentable; this pins the
  // behaviour of the broadcast dispatcher itself.
  // ---------------------------------------------------------------------
  describe("hook dispatch mode", () => {
    it("callAllHooks runs EVERY module's broadcast gate", async () => {
      const calls: string[] = [];
      await loadModulesFromInstances(
        [
          mockModule("gate-a", {
            hooks: {
              beforeSignup: async () => {
                calls.push("a");
              },
            },
          }),
          mockModule("gate-b", {
            hooks: {
              beforeSignup: async () => {
                calls.push("b");
              },
            },
          }),
        ],
        mockCtx(),
      );

      await callAllHooks("beforeSignup", "user@example.com", { headers: null });
      expect(calls).toEqual(["a", "b"]);
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
      expect(getModules().get("a")).toBeUndefined();
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
      expect(getModuleModelProviders()).toEqual([]);

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
      expect(hasHook("beforeUsage")).toBe(false);
      expect(hasHook("beforeSignup")).toBe(false);
      expect(hasHook("afterSignup")).toBe(false);

      // emitEvent is a silent no-op when no module listens — no handlers run
      // and no error propagates.
      await expect(
        emitEvent("onRunStatusChange", {
          orgId: "o",
          runId: "r",
          packageId: "a",
          spaceId: "spc_x",
          status: "success",
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("permissionsContribution (module RBAC)", () => {
    // The provider hook is module-loader → permissions, so we exercise the
    // public observable: orgPermissions() / presetPermissions() /
    // getApiKeyAllowedScopes() returning the merged view after a module loads.

    it("merges module org grants into orgPermissions(role)", async () => {
      const { orgPermissions } = await import("../../../src/lib/permissions.ts");
      await loadModulesFromInstances(
        [
          mockModule("tasks", {
            permissionsContribution: () => [
              {
                resource: "tasks",
                actions: ["read", "write"],
                level: "org",
                grantTo: ["owner", "admin", "member"],
              },
            ],
          }),
        ],
        mockCtx(),
      );
      const owner = orgPermissions("owner");
      const member = orgPermissions("member");
      const guest = orgPermissions("guest");
      expect(owner.has("tasks:read" as never)).toBe(true);
      expect(owner.has("tasks:write" as never)).toBe(true);
      expect(member.has("tasks:read" as never)).toBe(true);
      expect(guest.has("tasks:read" as never)).toBe(false);
      // Core grants still present
      expect(owner.has("org:delete" as never)).toBe(true);
    });

    it("resets the provider on resetModules() — next resolve sees no module grants", async () => {
      const { orgPermissions } = await import("../../../src/lib/permissions.ts");
      await loadModulesFromInstances(
        [
          mockModule("tasks", {
            permissionsContribution: () => [
              { resource: "tasks", actions: ["read"], level: "org", grantTo: ["owner"] },
            ],
          }),
        ],
        mockCtx(),
      );
      expect(orgPermissions("owner").has("tasks:read" as never)).toBe(true);
      resetModules();
      expect(orgPermissions("owner").has("tasks:read" as never)).toBe(false);
    });

    it("apiKeyGrantable=true adds entries to the API-key allowlist; false omits them", async () => {
      const { getApiKeyAllowedScopes } = await import("../../../src/lib/permissions.ts");
      await loadModulesFromInstances(
        [
          mockModule("tasks", {
            permissionsContribution: () => [
              {
                resource: "tasks",
                actions: ["read"],
                level: "org",
                grantTo: ["owner"],
                apiKeyGrantable: true,
              },
              {
                resource: "internal",
                actions: ["sweep"],
                level: "org",
                grantTo: ["owner"],
                // apiKeyGrantable defaults to false
              },
            ],
          }),
        ],
        mockCtx(),
      );
      const allowed = getApiKeyAllowedScopes();
      expect(allowed.has("tasks:read")).toBe(true);
      expect(allowed.has("internal:sweep")).toBe(false);
    });

    it("endUserGrantable=true adds entries to the end-user OIDC allowlist; false omits them", async () => {
      const { getModuleEndUserAllowedScopes } = await import("@appstrate/core/permissions");
      await loadModulesFromInstances(
        [
          mockModule("tasks", {
            permissionsContribution: () => [
              {
                resource: "tasks",
                actions: ["read", "write"],
                level: "org",
                grantTo: ["owner", "member"],
                endUserGrantable: true,
              },
              {
                resource: "internal",
                actions: ["sweep"],
                level: "org",
                grantTo: ["owner"],
                // endUserGrantable defaults to false — admin surfaces stay closed
              },
            ],
          }),
        ],
        mockCtx(),
      );
      const allowed = getModuleEndUserAllowedScopes();
      expect(allowed.has("tasks:read")).toBe(true);
      expect(allowed.has("tasks:write")).toBe(true);
      expect(allowed.has("internal:sweep")).toBe(false);
    });

    it("endUserGrantable is independent of apiKeyGrantable — both opt-ins are tracked separately", async () => {
      const { getApiKeyAllowedScopes } = await import("../../../src/lib/permissions.ts");
      const { getModuleEndUserAllowedScopes } = await import("@appstrate/core/permissions");
      await loadModulesFromInstances(
        [
          mockModule("tasks", {
            permissionsContribution: () => [
              {
                resource: "tasks",
                actions: ["read"],
                level: "org",
                grantTo: ["owner"],
                apiKeyGrantable: true,
                endUserGrantable: false,
              },
              {
                resource: "module-billing",
                actions: ["view"],
                level: "org",
                grantTo: ["owner"],
                apiKeyGrantable: false,
                endUserGrantable: true,
              },
            ],
          }),
        ],
        mockCtx(),
      );
      const apiKey = getApiKeyAllowedScopes();
      const endUser = getModuleEndUserAllowedScopes();
      expect(apiKey.has("tasks:read")).toBe(true);
      expect(apiKey.has("module-billing:view")).toBe(false);
      expect(endUser.has("tasks:read")).toBe(false);
      expect(endUser.has("module-billing:view")).toBe(true);
    });

    it("resets endUser allowlist on resetModules()", async () => {
      const { getModuleEndUserAllowedScopes } = await import("@appstrate/core/permissions");
      await loadModulesFromInstances(
        [
          mockModule("tasks", {
            permissionsContribution: () => [
              {
                resource: "tasks",
                actions: ["read"],
                level: "org",
                grantTo: ["owner"],
                endUserGrantable: true,
              },
            ],
          }),
        ],
        mockCtx(),
      );
      expect(getModuleEndUserAllowedScopes().has("tasks:read")).toBe(true);
      resetModules();
      expect(getModuleEndUserAllowedScopes().has("tasks:read")).toBe(false);
    });

    it("rejects redefining a core resource (e.g. agents)", async () => {
      const mod = mockModule("rogue", {
        // Cast: `agents` is a CORE resource, so it is absent from
        // `ModuleResources` and the type already refuses it. The runtime guard
        // must refuse it too, for a module that opted out of the types.
        permissionsContribution: () => [
          { resource: "agents", actions: ["pwn"], level: "org", grantTo: ["owner"] } as never,
        ],
      });
      await expect(loadModulesFromInstances([mod], mockCtx())).rejects.toThrow(
        /Module "rogue" cannot redefine core resource "agents"/,
      );
    });

    it("rejects two modules declaring the same resource", async () => {
      await expect(
        loadModulesFromInstances(
          [
            mockModule("tasks-a", {
              permissionsContribution: () => [
                { resource: "shared", actions: ["read"], level: "org", grantTo: ["owner"] },
              ],
            }),
            mockModule("tasks-b", {
              permissionsContribution: () => [
                { resource: "shared", actions: ["read"], level: "org", grantTo: ["owner"] },
              ],
            }),
          ],
          mockCtx(),
        ),
      ).rejects.toThrow(/both declared resource "shared"/);
    });

    it("rejects malformed resource name", async () => {
      const mod = mockModule("tasks", {
        // Cast: an un-augmented / mis-cased name no longer type-checks.
        permissionsContribution: () => [
          { resource: "Tasks", actions: ["read"], level: "org", grantTo: ["owner"] } as never,
        ],
      });
      await expect(loadModulesFromInstances([mod], mockCtx())).rejects.toThrow(
        /invalid permission resource "Tasks"/,
      );
    });

    it("rejects malformed action name", async () => {
      const mod = mockModule("tasks", {
        // Cast: `READ` is not one of the actions `tasks` declares.
        permissionsContribution: () => [
          { resource: "tasks", actions: ["READ" as never], level: "org", grantTo: ["owner"] },
        ],
      });
      await expect(loadModulesFromInstances([mod], mockCtx())).rejects.toThrow(
        /invalid action "READ"/,
      );
    });

    it("rejects empty actions array", async () => {
      const mod = mockModule("tasks", {
        permissionsContribution: () => [
          { resource: "tasks", actions: [], level: "org", grantTo: ["owner"] },
        ],
      });
      await expect(loadModulesFromInstances([mod], mockCtx())).rejects.toThrow(/with no actions/);
    });

    it("rejects unknown role in grantTo", async () => {
      const mod = mockModule("tasks", {
        permissionsContribution: () => [
          {
            resource: "tasks",
            actions: ["read"],
            level: "org",
            grantTo: ["god" as never],
          },
        ],
      });
      await expect(loadModulesFromInstances([mod], mockCtx())).rejects.toThrow(
        /unknown org role "god"/,
      );
    });

    it("supports per-action grants by listing the resource multiple times", async () => {
      const { orgPermissions } = await import("../../../src/lib/permissions.ts");
      await loadModulesFromInstances(
        [
          mockModule("tasks", {
            permissionsContribution: () => [
              { resource: "tasks", actions: ["write"], level: "org", grantTo: ["owner"] },
              { resource: "tasks", actions: ["read"], level: "org", grantTo: ["owner", "member"] },
            ],
          }),
        ],
        mockCtx(),
      );
      const owner = orgPermissions("owner");
      const member = orgPermissions("member");
      expect(owner.has("tasks:write" as never)).toBe(true);
      expect(owner.has("tasks:read" as never)).toBe(true);
      expect(member.has("tasks:write" as never)).toBe(false);
      expect(member.has("tasks:read" as never)).toBe(true);
    });

    it("space-level grants reach the presets that named them", async () => {
      const { presetPermissions } = await import("../../../src/lib/permissions.ts");
      await loadModulesFromInstances(
        [
          mockModule("tasks", {
            permissionsContribution: () => [
              {
                resource: "tasks",
                actions: ["read"],
                level: "space",
                presets: ["admin", "builder", "operator", "viewer"],
              },
              {
                resource: "tasks",
                actions: ["write"],
                level: "space",
                presets: ["admin", "builder"],
              },
            ],
          }),
        ],
        mockCtx(),
      );
      // Which org role holds which preset is now a per-space question; what
      // the loader owns is the preset → permission mapping.
      expect(presetPermissions("admin").has("tasks:write" as never)).toBe(true);
      expect(presetPermissions("builder").has("tasks:write" as never)).toBe(true);
      expect(presetPermissions("operator").has("tasks:write" as never)).toBe(false);
      expect(presetPermissions("operator").has("tasks:read" as never)).toBe(true);
      expect(presetPermissions("viewer").has("tasks:read" as never)).toBe(true);
    });

    it("rejects unknown preset in presets", async () => {
      const mod = mockModule("tasks", {
        permissionsContribution: () => [
          {
            resource: "tasks",
            actions: ["read"],
            level: "space",
            presets: ["superuser" as never],
          },
        ],
      });
      await expect(loadModulesFromInstances([mod], mockCtx())).rejects.toThrow(
        /unknown space-role preset "superuser"/,
      );
    });

    it("rejects a resource declared at two different levels", async () => {
      const mod = mockModule("tasks", {
        permissionsContribution: () => [
          { resource: "tasks", actions: ["read"], level: "org", grantTo: ["owner"] },
          { resource: "tasks", actions: ["write"], level: "space", presets: ["admin"] },
        ],
      });
      await expect(loadModulesFromInstances([mod], mockCtx())).rejects.toThrow(
        /must declare the same level/,
      );
    });

    it("OSS baseline: no module loaded → only core grants", async () => {
      const { orgPermissions, presetPermissions } = await import("../../../src/lib/permissions.ts");
      await loadModulesFromInstances([], mockCtx());
      expect(orgPermissions("owner").has("org:delete" as never)).toBe(true);
      expect(orgPermissions("owner").has("tasks:read" as never)).toBe(false);
      expect(presetPermissions("admin").has("agents:run" as never)).toBe(true);
      expect(presetPermissions("admin").has("tasks:read" as never)).toBe(false);
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
      });
    });

    it("flattens plugins from multiple modules in load order", async () => {
      const plugA = { id: "plug-a" };
      const plugB1 = { id: "plug-b1" };
      const plugB2 = { id: "plug-b2" };
      await loadModulesFromInstances(
        [
          mockModule("a", { betterAuthPlugins: () => [plugA] }),
          mockModule("b", { betterAuthPlugins: () => [plugB1, plugB2] }),
        ],
        mockCtx(),
      );
      const contributions = getModuleContributions();
      expect(contributions.betterAuthPlugins).toEqual([plugA, plugB1, plugB2]);
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
      });
    });
  });

  describe("getModuleModelProviders", () => {
    function fakeProvider(id: string): ModelProviderDefinition {
      return {
        providerId: id,
        displayName: id,
        iconUrl: "openai",
        apiShape: "openai-completions",
        defaultBaseUrl: "https://api.example.com",
        baseUrlOverridable: false,
        authMode: "api_key",
        featuredModels: [],
      };
    }

    it("returns [] when no module contributes (OSS zero-footprint invariant)", async () => {
      await loadModulesFromInstances([mockModule("alpha"), mockModule("beta")], mockCtx());
      expect(getModuleModelProviders()).toEqual([]);
    });

    it("aggregates providers from every module in module load order", async () => {
      const a = mockModule("a", {
        modelProviders: () => [fakeProvider("openai"), fakeProvider("anthropic")],
      });
      const b = mockModule("b", { modelProviders: () => [fakeProvider("extra-oauth")] });
      await loadModulesFromInstances([a, b], mockCtx());
      const ids = getModuleModelProviders().map((p) => p.providerId);
      expect(ids).toEqual(["openai", "anthropic", "extra-oauth"]);
    });

    it("throws when two modules contribute the same providerId", async () => {
      const a = mockModule("a", { modelProviders: () => [fakeProvider("openai")] });
      const b = mockModule("b", { modelProviders: () => [fakeProvider("openai")] });
      await expect(loadModulesFromInstances([a, b], mockCtx())).resolves.toBeUndefined();
      expect(() => getModuleModelProviders()).toThrow(/both declared model provider "openai"/);
    });

    it("preserves provider hooks intact on the returned definitions", async () => {
      const extractTokenIdentity = (token: string) => ({ accountId: token.slice(0, 4) });
      const a = mockModule("a", {
        modelProviders: () => [
          {
            ...fakeProvider("extra-oauth"),
            authMode: "oauth2",
            oauth: {
              clientId: "x",
              authorizationUrl: "https://example.com/authorize",
              tokenUrl: "https://example.com/token",
              refreshUrl: "https://example.com/token",
              scopes: ["openid"],
              pkce: "S256",
            },
            hooks: { extractTokenIdentity },
          },
        ],
      });
      await loadModulesFromInstances([a], mockCtx());
      const providers = getModuleModelProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0]?.hooks?.extractTokenIdentity).toBe(extractTokenIdentity);
    });

    it("returns [] after resetModules()", async () => {
      await loadModulesFromInstances(
        [mockModule("a", { modelProviders: () => [fakeProvider("openai")] })],
        mockCtx(),
      );
      expect(getModuleModelProviders()).toHaveLength(1);
      resetModules();
      expect(getModuleModelProviders()).toEqual([]);
    });
  });
});
