// SPDX-License-Identifier: Apache-2.0

import type { Hono } from "hono";
import type { AppConfig } from "@appstrate/shared-types";
import type {
  AppstrateModule,
  ModuleInitContext,
  ModuleHooks,
  ModuleEvents,
  AuthStrategy,
} from "@appstrate/core/module";
import { readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import type { AppEnv } from "../../types/index.ts";
import { logger } from "../logger.ts";

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

const _modules: Map<string, AppstrateModule> = new Map();
let _publicPathsCache: Set<string> | null = null;
let _authStrategiesCache: AuthStrategy[] | null = null;
let _betterAuthPluginsCache: unknown[] | null = null;
let _drizzleSchemasCache: Record<string, unknown> | null = null;
let _initialized = false;

// Built-in module discovery: scanned once, then cached for the process lifetime.
// Maps built-in module id → absolute path of its index.ts.
let _builtinCache: Map<string, string> | null = null;

function getBuiltinModules(): Map<string, string> {
  if (_builtinCache !== null) return _builtinCache;

  const cache = new Map<string, string>();
  const here = dirname(fileURLToPath(import.meta.url));
  const modulesDir = resolve(here, "../../modules");

  if (existsSync(modulesDir)) {
    for (const entry of readdirSync(modulesDir)) {
      const entryPath = join(modulesDir, entry);
      try {
        if (!statSync(entryPath).isDirectory()) continue;
      } catch {
        continue;
      }
      const indexPath = join(entryPath, "index.ts");
      if (existsSync(indexPath)) cache.set(entry, indexPath);
    }
  }

  _builtinCache = cache;
  return cache;
}

/**
 * Resolve a module specifier. If a built-in module with that id exists under
 * `apps/api/src/modules/<specifier>/index.ts`, it's loaded from that path;
 * otherwise the specifier is treated as an npm package name and loaded via
 * dynamic import. The built-in directory is scanned only once per process.
 */
async function resolveSpecifier(specifier: string): Promise<{
  default?: AppstrateModule;
  appstrateModule?: AppstrateModule;
}> {
  const builtinPath = getBuiltinModules().get(specifier);
  if (builtinPath) {
    return import(/* webpackIgnore: true */ builtinPath);
  }
  return import(/* webpackIgnore: true */ specifier);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and initialize all registered modules.
 *
 * Each entry is a dynamic import specifier. The loader:
 * 1. Resolves modules via dynamic import
 * 2. Topologically sorts by `manifest.dependencies`
 * 3. Calls `init(ctx)` in dependency order
 *
 * All declared modules are required — any import or init failure is fatal.
 * If a module is not needed, remove it from the APPSTRATE_MODULES env var.
 */
export async function loadModules(specifiers: string[], ctx: ModuleInitContext): Promise<void> {
  if (_initialized) {
    logger.debug("Modules already initialized, skipping");
    return;
  }

  // Phase 1: Resolve all modules via dynamic import (built-in path first, then npm specifier)
  const resolved: AppstrateModule[] = [];
  for (const specifier of specifiers) {
    try {
      const raw = await resolveSpecifier(specifier);
      // Support both default export and named `appstrateModule` export
      const mod = (raw.default ?? raw.appstrateModule) as AppstrateModule | undefined;
      if (!mod?.manifest?.id) {
        throw new Error(`Module "${specifier}" is missing manifest.id`);
      }
      resolved.push(mod);
    } catch (err) {
      throw new Error(
        `Module "${specifier}" could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  // Phase 2: Topological sort by dependencies
  const sorted = topoSort(resolved);

  // Phase 2.5: Fail fast on duplicate route prefixes before any init runs
  validateNoDuplicatePrefixes(sorted);

  // Phase 3: Init in dependency order
  for (const mod of sorted) {
    try {
      await mod.init(ctx);
      if (_modules.has(mod.manifest.id)) {
        logger.warn("Duplicate module ID, overwriting", { id: mod.manifest.id });
      }
      _modules.set(mod.manifest.id, mod);
      logger.info("Module loaded", { id: mod.manifest.id, version: mod.manifest.version });
    } catch (err) {
      throw new Error(
        `Module "${mod.manifest.id}" failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  _initialized = true;
}

/**
 * Load modules from pre-resolved instances (for tests).
 * Skips the dynamic import phase — modules are passed directly.
 */
export async function loadModulesFromInstances(
  modules: AppstrateModule[],
  ctx: ModuleInitContext,
): Promise<void> {
  if (_initialized) {
    logger.debug("Modules already initialized, skipping");
    return;
  }

  const sorted = topoSort(modules);
  validateNoDuplicatePrefixes(sorted);
  for (const mod of sorted) {
    try {
      await mod.init(ctx);
    } catch (err) {
      throw new Error(
        `Module "${mod.manifest.id}" failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (_modules.has(mod.manifest.id)) {
      logger.warn("Duplicate module ID, overwriting", { id: mod.manifest.id });
    }
    _modules.set(mod.manifest.id, mod);
  }

  _initialized = true;
}

/**
 * Throw if any two modules declare the same `appScopedPaths` prefix.
 *
 * Without this guard, Hono silently routes to the first match and the second
 * module becomes inert — a nasty class of silent override. We run the check
 * both at module load time and in the test harness so collisions surface
 * immediately with a clear error message.
 */
export function validateNoDuplicatePrefixes(modules: readonly AppstrateModule[]): void {
  const seen = new Map<string, string>();
  for (const mod of modules) {
    for (const prefix of mod.appScopedPaths ?? []) {
      const existing = seen.get(prefix);
      if (existing && existing !== mod.manifest.id) {
        throw new Error(
          `Duplicate module appScopedPath "${prefix}" declared by both "${existing}" and "${mod.manifest.id}"`,
        );
      }
      seen.set(prefix, mod.manifest.id);
    }
  }
}

/** Get a loaded module by ID, or null if not loaded. */
export function getModule(id: string): AppstrateModule | null {
  return _modules.get(id) ?? null;
}

/** Get all loaded modules (iteration order = init order). */
export function getModules(): ReadonlyMap<string, AppstrateModule> {
  return _modules;
}

/** Collect all public paths from all loaded modules (cached as Set for O(1) lookup). */
export function getModulePublicPaths(): Set<string> {
  if (_publicPathsCache !== null) return _publicPathsCache;
  _publicPathsCache = new Set(Array.from(_modules.values()).flatMap((m) => m.publicPaths ?? []));
  return _publicPathsCache;
}

/** Collect routers from all modules and mount them on the app under `/api`. */
export function registerModuleRoutes(app: Hono<AppEnv>): void {
  for (const mod of _modules.values()) {
    const router = mod.createRouter?.();
    if (router) {
      app.route("/api", router);
    }
  }
}

/**
 * Collect app-scoped route prefixes contributed by loaded modules.
 * Core prefixes (agents, runs, …) are declared separately in `index.ts`.
 */
export function getModuleAppScopedPaths(): string[] {
  const paths: string[] = [];
  for (const mod of _modules.values()) {
    if (mod.appScopedPaths) paths.push(...mod.appScopedPaths);
  }
  return paths;
}

/** Collect OpenAPI path definitions from all loaded modules. */
export function getModuleOpenApiPaths(): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const mod of _modules.values()) {
    const modulePaths = mod.openApiPaths?.();
    if (modulePaths) Object.assign(paths, modulePaths);
  }
  return paths;
}

/** Collect OpenAPI component schema definitions from all loaded modules. */
export function getModuleOpenApiComponentSchemas(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const mod of _modules.values()) {
    const moduleSchemas = mod.openApiComponentSchemas?.();
    if (moduleSchemas) Object.assign(schemas, moduleSchemas);
  }
  return schemas;
}

/** Collect OpenAPI tags contributed by all loaded modules. */
export function getModuleOpenApiTags(): Array<{ name: string; description?: string }> {
  const tags: Array<{ name: string; description?: string }> = [];
  for (const mod of _modules.values()) {
    const moduleTags = mod.openApiTags?.();
    if (moduleTags) tags.push(...moduleTags);
  }
  return tags;
}

/**
 * Collect auth strategies contributed by all loaded modules.
 *
 * Strategies run in module load order, BEFORE core auth (Bearer ask_ API key
 * → session cookie). First-match-wins: the first strategy returning a
 * non-null resolution claims the request. Cached on first call.
 *
 * OSS invariant: returns `[]` when no module provides `authStrategies()`.
 */
export function getModuleAuthStrategies(): AuthStrategy[] {
  if (_authStrategiesCache !== null) return _authStrategiesCache;
  const strategies: AuthStrategy[] = [];
  for (const mod of _modules.values()) {
    const contrib = mod.authStrategies?.();
    if (contrib) strategies.push(...contrib);
  }
  _authStrategiesCache = strategies;
  return strategies;
}

/**
 * Collect Better Auth plugins contributed by all loaded modules.
 *
 * Passed through as `unknown[]` at this layer — the boot integration site
 * in `packages/db/src/auth.ts` narrows to `BetterAuthPluginList` before
 * calling `createAuth(plugins)`. Keeps Better Auth types out of core.
 *
 * OSS invariant: returns `[]` when no module provides `betterAuthPlugins()`.
 */
export function getModuleBetterAuthPlugins(): unknown[] {
  if (_betterAuthPluginsCache !== null) return _betterAuthPluginsCache;
  const plugins: unknown[] = [];
  for (const mod of _modules.values()) {
    const contrib = mod.betterAuthPlugins?.();
    if (contrib) plugins.push(...contrib);
  }
  _betterAuthPluginsCache = plugins;
  return plugins;
}

/**
 * Collect Drizzle table definitions contributed by all loaded modules.
 *
 * Better Auth's Drizzle adapter needs these to resolve `findOne({ model })`
 * calls against module-owned tables (e.g. the OIDC module's `jwks` and
 * `oauthClient` tables). Passed through as `Record<string, unknown>` at
 * this layer — the boot integration site narrows the values to Drizzle
 * tables before passing to `createAuth(plugins, schemas)`.
 *
 * OSS invariant: returns `{}` when no module provides `drizzleSchemas()`.
 */
export function getModuleDrizzleSchemas(): Record<string, unknown> {
  if (_drizzleSchemasCache !== null) return _drizzleSchemasCache;
  const schemas: Record<string, unknown> = {};
  for (const mod of _modules.values()) {
    const contrib = mod.drizzleSchemas?.();
    if (contrib) Object.assign(schemas, contrib);
  }
  _drizzleSchemasCache = schemas;
  return schemas;
}

/**
 * Merge module feature flags into the base AppConfig.
 * Each module's `features` is a `Record<string, boolean>` merged via `Object.assign`.
 */
export function applyModuleFeatures(base: AppConfig): AppConfig {
  const moduleFeatures: Record<string, boolean> = {};
  for (const mod of _modules.values()) {
    if (mod.features) Object.assign(moduleFeatures, mod.features);
  }
  return {
    ...base,
    features: { ...base.features, ...moduleFeatures },
  };
}

// ---------------------------------------------------------------------------
// Agnostic hook system
// ---------------------------------------------------------------------------

/**
 * Call a named hook — returns the result from the FIRST module that
 * provides it, or `undefined` if no module provides it.
 *
 * **First-match-wins:** Modules are iterated in topological init order.
 * If the first module that provides a hook returns a value (including `null`),
 * subsequent modules are never consulted. Load order (determined by
 * `manifest.dependencies` topological sort) defines priority — modules with
 * no dependencies keep the order they appear in `APPSTRATE_MODULES`.
 *
 * Example: `APPSTRATE_MODULES=cloud,quota` — if both provide `beforeRun`,
 * cloud runs first. To force ordering regardless of env order, add
 * `dependencies: ["cloud"]` on quota so the topo sort always places cloud
 * earlier.
 *
 * For broadcast-to-all semantics, use `emitEvent()` instead.
 */
// Internal type: hooks/events objects cast to indexable records for dynamic dispatch.
// The public types (ModuleHooks/ModuleEvents) are strict — this cast is only used
// inside the loader where dispatch is inherently dynamic (by hook/event name).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (...args: any[]) => any;

/** Unwrap the Promise return type of a hook. */
type HookResult<K extends keyof ModuleHooks> = Awaited<ReturnType<ModuleHooks[K]>>;

export async function callHook<K extends keyof ModuleHooks>(
  name: K,
  ...args: Parameters<ModuleHooks[K]>
): Promise<HookResult<K> | undefined> {
  for (const mod of _modules.values()) {
    const hook = (mod.hooks as Record<string, AnyHandler> | undefined)?.[name];
    if (hook) {
      return (await hook(...args)) as HookResult<K>;
    }
  }
  return undefined;
}

/** Check if any loaded module provides a given hook. */
export function hasHook(name: keyof ModuleHooks): boolean {
  for (const mod of _modules.values()) {
    if ((mod.hooks as Record<string, AnyHandler> | undefined)?.[name]) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Event system (broadcast to ALL modules)
// ---------------------------------------------------------------------------

/**
 * Emit a named event to ALL loaded modules that listen for it.
 * Unlike callHook (first-match-wins), this calls every module's handler.
 * Errors in individual handlers are logged but don't block other modules.
 */
export async function emitEvent<K extends keyof ModuleEvents>(
  name: K,
  ...args: Parameters<ModuleEvents[K]>
): Promise<void> {
  for (const mod of _modules.values()) {
    const handler = (mod.events as Record<string, AnyHandler> | undefined)?.[name];
    if (handler) {
      try {
        await handler(...args);
      } catch (err) {
        logger.warn("Module event handler error", {
          module: mod.manifest.id,
          event: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shutdown + reset
// ---------------------------------------------------------------------------

/** Shutdown all modules in reverse init order. */
export async function shutdownModules(): Promise<void> {
  const mods = Array.from(_modules.values()).reverse();
  for (const mod of mods) {
    try {
      await mod.shutdown?.();
    } catch (err) {
      logger.warn("Module shutdown error", {
        id: mod.manifest.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  _modules.clear();
  _publicPathsCache = null;
  _authStrategiesCache = null;
  _betterAuthPluginsCache = null;
  _drizzleSchemasCache = null;
  _initialized = false;
}

/** Reset all state. Exported for tests only. */
export function resetModules(): void {
  _modules.clear();
  _publicPathsCache = null;
  _authStrategiesCache = null;
  _betterAuthPluginsCache = null;
  _drizzleSchemasCache = null;
  _builtinCache = null;
  _initialized = false;
}

// ---------------------------------------------------------------------------
// Topological sort (Kahn's algorithm)
// ---------------------------------------------------------------------------

function topoSort(modules: AppstrateModule[]): AppstrateModule[] {
  const byId = new Map(modules.map((m) => [m.manifest.id, m]));
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const m of modules) {
    const id = m.manifest.id;
    if (!inDegree.has(id)) inDegree.set(id, 0);
    if (!adj.has(id)) adj.set(id, []);

    for (const dep of m.manifest.dependencies ?? []) {
      if (!byId.has(dep)) continue;
      if (!adj.has(dep)) adj.set(dep, []);
      adj.get(dep)!.push(id);
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: AppstrateModule[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const mod = byId.get(id);
    if (mod) sorted.push(mod);

    for (const neighbor of adj.get(id) ?? []) {
      const deg = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, deg);
      if (deg === 0) queue.push(neighbor);
    }
  }

  if (sorted.length !== modules.length) {
    const missing = modules.filter((m) => !sorted.includes(m)).map((m) => m.manifest.id);
    throw new Error(`Circular module dependency detected: ${missing.join(", ")}`);
  }

  return sorted;
}
