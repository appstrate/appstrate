// SPDX-License-Identifier: Apache-2.0

import type { AppConfig } from "@appstrate/shared-types";
import type { AppstrateModule, ModuleEntry, ModuleInitContext } from "@appstrate/core/module";
import { SkipModuleError } from "@appstrate/core/module";
import { logger } from "../logger.ts";

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

const _modules: Map<string, AppstrateModule> = new Map();
let _publicPathsCache: string[] | null = null;
let _initialized = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and initialize all registered modules.
 *
 * Each entry is a dynamic import specifier. The loader:
 * 1. Resolves modules via dynamic import (skip if not installed)
 * 2. Topologically sorts by `manifest.dependencies`
 * 3. Calls `init(ctx)` in dependency order
 *
 * The platform never references module internals — it only calls the
 * AppstrateModule contract methods.
 */
export async function loadModules(entries: ModuleEntry[], ctx: ModuleInitContext): Promise<void> {
  if (_initialized) return;

  // Phase 1: Resolve all modules via dynamic import
  const resolved: { module: AppstrateModule; required: boolean }[] = [];
  for (const entry of entries) {
    try {
      const pkg = entry.specifier;
      const raw = await import(/* webpackIgnore: true */ pkg);
      // Support both default export and named `appstrateModule` export
      const mod: AppstrateModule = raw.default ?? raw.appstrateModule;
      if (!mod?.manifest?.id) {
        logger.warn("Module missing manifest.id, skipping", { specifier: entry.specifier });
        continue;
      }
      resolved.push({ module: mod, required: entry.required ?? false });
    } catch {
      if (entry.required) {
        throw new Error(`Required module not found: ${entry.specifier}`);
      }
      logger.debug("Optional module not installed, skipping", { specifier: entry.specifier });
    }
  }

  // Phase 2: Topological sort by dependencies
  const sorted = topoSort(resolved.map((r) => r.module));
  const requiredIds = new Set(resolved.filter((r) => r.required).map((r) => r.module.manifest.id));

  // Phase 3: Init in dependency order
  for (const mod of sorted) {
    try {
      await mod.init(ctx);
      _modules.set(mod.manifest.id, mod);
      logger.info("Module loaded", { id: mod.manifest.id, version: mod.manifest.version });
    } catch (err) {
      if (err instanceof SkipModuleError) {
        logger.debug("Module skipped", { id: mod.manifest.id, reason: err.message });
        continue;
      }
      if (requiredIds.has(mod.manifest.id)) {
        throw err;
      }
      logger.warn("Module init failed, skipping", {
        id: mod.manifest.id,
        error: err instanceof Error ? err.message : String(err),
      });
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
  if (_initialized) return;

  const sorted = topoSort(modules);
  for (const mod of sorted) {
    try {
      await mod.init(ctx);
      _modules.set(mod.manifest.id, mod);
    } catch (err) {
      if (err instanceof SkipModuleError) continue;
      throw err;
    }
  }

  _initialized = true;
}

/** Get a loaded module by ID, or null if not loaded. */
export function getModule(id: string): AppstrateModule | null {
  return _modules.get(id) ?? null;
}

/** Get all loaded modules (iteration order = init order). */
export function getModules(): ReadonlyMap<string, AppstrateModule> {
  return _modules;
}

/** Collect all public paths from all loaded modules (cached). */
export function getModulePublicPaths(): string[] {
  if (_publicPathsCache) return _publicPathsCache;
  _publicPathsCache = Array.from(_modules.values()).flatMap((m) => m.publicPaths ?? []);
  return _publicPathsCache;
}

/** Register all module routes on the app. */
export function registerModuleRoutes(app: unknown): void {
  for (const mod of _modules.values()) {
    mod.registerRoutes?.(app);
  }
}

/** Extend AppConfig with all module contributions (deep merge). */
export function applyModuleAppConfig(base: AppConfig): AppConfig {
  let config: AppConfig = { ...base };
  for (const mod of _modules.values()) {
    const ext = mod.extendAppConfig?.(config as unknown as Record<string, unknown>);
    if (ext) {
      config = deepMerge(config as unknown as Record<string, unknown>, ext) as unknown as AppConfig;
    }
  }
  return config;
}

// ---------------------------------------------------------------------------
// Agnostic hook system
// ---------------------------------------------------------------------------

/**
 * Call a named hook on ALL loaded modules that provide it.
 * Returns the result from the FIRST module that provides the hook,
 * or undefined if no module provides it.
 *
 * This is fully agnostic — the platform never knows which module
 * provides which hook.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function callHook<T = unknown>(name: string, ...args: any[]): Promise<T | undefined> {
  for (const mod of _modules.values()) {
    const hook = mod.hooks?.[name];
    if (hook) {
      return (await hook(...args)) as T;
    }
  }
  return undefined;
}

/**
 * Get a value from a named hook synchronously (e.g. error constructors).
 * Returns the result from the first module that provides the hook, or null.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getHookValue<T = unknown>(name: string, ...args: any[]): T | null {
  for (const mod of _modules.values()) {
    const hook = mod.hooks?.[name];
    if (hook) {
      return hook(...args) as T;
    }
  }
  return null;
}

/** Check if any loaded module provides a given hook. */
export function hasHook(name: string): boolean {
  for (const mod of _modules.values()) {
    if (mod.hooks?.[name]) return true;
  }
  return false;
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
  _initialized = false;
}

/** Reset all state. Exported for tests only. */
export function resetModules(): void {
  _modules.clear();
  _publicPathsCache = null;
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

// ---------------------------------------------------------------------------
// Deep merge utility
// ---------------------------------------------------------------------------

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const tVal = target[key];
    const sVal = source[key];
    if (
      tVal &&
      sVal &&
      typeof tVal === "object" &&
      typeof sVal === "object" &&
      !Array.isArray(tVal) &&
      !Array.isArray(sVal)
    ) {
      result[key] = deepMerge(tVal as Record<string, unknown>, sVal as Record<string, unknown>);
    } else {
      result[key] = sVal;
    }
  }
  return result;
}
