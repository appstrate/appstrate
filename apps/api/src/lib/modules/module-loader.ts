// SPDX-License-Identifier: Apache-2.0

import type { AppConfig } from "@appstrate/shared-types";
import type {
  AppstrateModule,
  ModuleInitContext,
  ModuleHooks,
  ModuleEvents,
} from "@appstrate/core/module";
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

  // Phase 1: Resolve all modules via dynamic import
  const resolved: AppstrateModule[] = [];
  for (const specifier of specifiers) {
    try {
      const raw = await import(/* webpackIgnore: true */ specifier);
      // Support both default export and named `appstrateModule` export
      const mod: AppstrateModule = raw.default ?? raw.appstrateModule;
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
  for (const mod of sorted) {
    await mod.init(ctx);
    if (_modules.has(mod.manifest.id)) {
      logger.warn("Duplicate module ID, overwriting", { id: mod.manifest.id });
    }
    _modules.set(mod.manifest.id, mod);
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
  if (_publicPathsCache !== null) return _publicPathsCache;
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
 * Call a named hook — returns the result from the FIRST module that
 * provides it, or undefined if no module provides it.
 * For broadcasting to ALL modules, use emitEvent() instead.
 *
 * This is fully agnostic — the platform never knows which module
 * provides which hook.
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

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (typeof val !== "object" || val === null || Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === null || proto === Object.prototype;
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const tVal = target[key];
    const sVal = source[key];
    if (isPlainObject(tVal) && isPlainObject(sVal)) {
      result[key] = deepMerge(tVal, sVal);
    } else {
      result[key] = sVal;
    }
  }
  return result;
}
