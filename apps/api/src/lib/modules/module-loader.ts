// SPDX-License-Identifier: Apache-2.0

import type { Hono } from "hono";
import type { AppConfig } from "@appstrate/shared-types";
import type { AppEnv } from "../../types/index.ts";
import type { AppstrateModule, ModuleEntry, ModuleInitContext } from "./types.ts";
import { SkipModuleError } from "./types.ts";
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
 * Called once from `boot()`. Resolves modules, topologically sorts by
 * dependencies, then inits each in order.
 */
export async function loadModules(entries: ModuleEntry[], ctx: ModuleInitContext): Promise<void> {
  if (_initialized) return;

  const modules = entries.map((e) => e.module);
  const requiredIds = new Set(entries.filter((e) => e.required).map((e) => e.module.manifest.id));

  // Topological sort by dependencies
  const sorted = topoSort(modules);

  // Init in dependency order
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

/** Register all module routes on the Hono app. */
export function registerModuleRoutes(app: Hono<AppEnv>): void {
  for (const mod of _modules.values()) {
    mod.registerRoutes?.(app);
  }
}

/** Extend AppConfig with all module contributions (deep merge). */
export function applyModuleAppConfig(base: AppConfig): AppConfig {
  let config: AppConfig = { ...base };
  for (const mod of _modules.values()) {
    const ext = mod.extendAppConfig?.(config);
    if (ext) {
      config = deepMerge(
        config as unknown as Record<string, unknown>,
        ext as Record<string, unknown>,
      ) as unknown as AppConfig;
    }
  }
  return config;
}

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
      // Only count dependencies that are in our module set
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
