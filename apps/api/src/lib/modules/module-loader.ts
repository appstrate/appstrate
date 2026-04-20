// SPDX-License-Identifier: Apache-2.0

import type { Hono } from "hono";
import type { AppConfig } from "@appstrate/shared-types";
import type {
  AppstrateModule,
  ModuleInitContext,
  ModuleHooks,
  ModuleEvents,
  AuthStrategy,
  ModulePermissionContribution,
} from "@appstrate/core/module";
import type { OrgRole } from "../../types/index.ts";
import {
  CORE_RESOURCE_NAMES,
  setModulePermissionsProvider,
  type ModulePermissionsSnapshot,
} from "../permissions.ts";
import { readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import type { AppEnv } from "../../types/index.ts";
import { logger } from "../logger.ts";

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

const _modules: Map<string, AppstrateModule> = new Map();
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
 * If a module is not needed, remove it from the MODULES env var.
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

  await initSortedModules(resolved, ctx);
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
  await initSortedModules(modules, ctx);
}

/**
 * Shared init pipeline: topo-sort → duplicate-prefix guard → init in
 * dependency order → register. Fatal on first failure.
 */
async function initSortedModules(
  modules: AppstrateModule[],
  ctx: ModuleInitContext,
): Promise<void> {
  const sorted = topoSort(modules);
  validateNoDuplicatePrefixes(sorted);
  validateModuleOidcScopes(sorted);
  // Compute the RBAC snapshot from module contributions and register it
  // BEFORE init() runs, so any module that calls `resolvePermissions(...)`
  // during init (e.g. seeding default API keys with module-owned scopes)
  // sees the merged view.
  const rbacSnapshot = collectModulePermissions(sorted);
  setModulePermissionsProvider(() => rbacSnapshot);
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
    logger.info("Module loaded", { id: mod.manifest.id, version: mod.manifest.version });
  }
  _initialized = true;
}

/**
 * Format enforced on module-contributed OIDC scopes: lowercase
 * `namespace:action`, alphanumeric + `_` + `-`, both halves required.
 *
 * The compile-time `${string}:${string}` template literal on
 * `AppstrateModule.oidcScopes` already forbids single-word scopes (which
 * are reserved for the OIDC identity vocabulary `openid|profile|email|
 * offline_access`). This regex tightens the runtime contract — rejects
 * uppercase, whitespace, and exotic characters that a `string`-typed
 * value coming from JSON config or a JS module could still smuggle in.
 */
const MODULE_OIDC_SCOPE_PATTERN = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/;

/**
 * Fail-fast at boot if any module declares an `oidcScopes` entry that
 * doesn't match `MODULE_OIDC_SCOPE_PATTERN`. The OIDC module is exempt:
 * its canonical vocabulary (identity + permission scopes) lives in
 * `modules/oidc/auth/scopes.ts` and follows its own rules — single-word
 * identity scopes are intentional there.
 *
 * Errors name the offending module + scope so the operator can fix the
 * declaration without grepping. Run alongside `validateNoDuplicatePrefixes`
 * in `initSortedModules` so the platform refuses to boot rather than
 * silently shipping malformed scopes into discovery / `assertValidScopes`.
 */
export function validateModuleOidcScopes(modules: readonly AppstrateModule[]): void {
  for (const mod of modules) {
    if (mod.manifest.id === "oidc") continue;
    const scopes = mod.oidcScopes;
    if (!scopes) continue;
    for (const scope of scopes) {
      if (typeof scope !== "string" || !MODULE_OIDC_SCOPE_PATTERN.test(scope)) {
        throw new Error(
          `Module "${mod.manifest.id}" declared invalid oidcScope ${JSON.stringify(scope)}. ` +
            `Expected lowercase "namespace:action" matching ${MODULE_OIDC_SCOPE_PATTERN}.`,
        );
      }
    }
  }
}

/**
 * Format enforced on module-contributed RBAC names (resources + actions).
 * Same shape as the OIDC scope guard — lowercase identifier with optional
 * `_`/`-` separators. Validated at boot for both halves.
 */
const MODULE_RBAC_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

/**
 * Aggregate `permissionsContribution()` from every loaded module into a
 * single snapshot consumable by `apps/api/src/lib/permissions.ts`. Runs
 * fail-fast validation:
 *   - resource name format
 *   - resource collision with a core resource (`org`, `agents`, …)
 *   - resource collision between two modules
 *   - action name format
 *   - empty `actions` (would contribute nothing)
 *   - empty `grantTo` (legal — declares the resource without granting it,
 *     useful when API-key-only access is intended; we just warn-log)
 *
 * Returns the snapshot in `ModulePermissionsSnapshot` shape — Sets keyed
 * by role plus the API-key allowlist union.
 */
export function collectModulePermissions(
  modules: readonly AppstrateModule[],
): ModulePermissionsSnapshot {
  const byRole: Record<OrgRole, Set<string>> = {
    owner: new Set(),
    admin: new Set(),
    member: new Set(),
    viewer: new Set(),
  };
  const apiKeyAllowed = new Set<string>();
  const ownerByResource = new Map<string, string>(); // resource → first module that claimed it

  for (const mod of modules) {
    const contributions = mod.permissionsContribution?.();
    if (!contributions) continue;
    for (const entry of contributions) {
      validateContribution(entry, mod.manifest.id, ownerByResource);
      for (const action of entry.actions) {
        const perm = `${entry.resource}:${action}`;
        for (const role of entry.grantTo) byRole[role].add(perm);
        if (entry.apiKeyGrantable) apiKeyAllowed.add(perm);
      }
    }
  }

  return { byRole, apiKeyAllowed };
}

function validateContribution(
  entry: ModulePermissionContribution,
  moduleId: string,
  ownerByResource: Map<string, string>,
): void {
  const { resource, actions, grantTo } = entry;

  if (!MODULE_RBAC_NAME_PATTERN.test(resource)) {
    throw new Error(
      `Module "${moduleId}" declared invalid permission resource ${JSON.stringify(resource)}. ` +
        `Expected lowercase identifier matching ${MODULE_RBAC_NAME_PATTERN}.`,
    );
  }
  if (CORE_RESOURCE_NAMES.has(resource)) {
    throw new Error(
      `Module "${moduleId}" cannot redefine core resource ${JSON.stringify(resource)}. ` +
        `Pick a namespaced resource name (e.g. "${moduleId}-${resource}") or a unique name.`,
    );
  }
  const previousOwner = ownerByResource.get(resource);
  if (previousOwner && previousOwner !== moduleId) {
    throw new Error(
      `Modules "${previousOwner}" and "${moduleId}" both declared resource ` +
        `${JSON.stringify(resource)}. Resource names must be unique across loaded modules.`,
    );
  }
  ownerByResource.set(resource, moduleId);

  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error(
      `Module "${moduleId}" declared resource ${JSON.stringify(resource)} with no actions.`,
    );
  }
  for (const action of actions) {
    if (typeof action !== "string" || !MODULE_RBAC_NAME_PATTERN.test(action)) {
      throw new Error(
        `Module "${moduleId}" declared invalid action ${JSON.stringify(action)} on resource ` +
          `${JSON.stringify(resource)}. Expected lowercase identifier matching ${MODULE_RBAC_NAME_PATTERN}.`,
      );
    }
  }

  if (!Array.isArray(grantTo)) {
    throw new Error(
      `Module "${moduleId}" declared resource ${JSON.stringify(resource)} with non-array grantTo.`,
    );
  }
  const allowedRoles = new Set<string>(["owner", "admin", "member", "viewer"]);
  for (const role of grantTo) {
    if (!allowedRoles.has(role)) {
      throw new Error(
        `Module "${moduleId}" declared resource ${JSON.stringify(resource)} with unknown role ` +
          `${JSON.stringify(role)}. Expected one of owner|admin|member|viewer.`,
      );
    }
  }
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

/** Collect all public paths from all loaded modules (Set for O(1) lookup). */
export function getModulePublicPaths(): Set<string> {
  return new Set(Array.from(_modules.values()).flatMap((m) => m.publicPaths ?? []));
}

/**
 * Collect routers from all modules and mount them at the HTTP origin root
 * (`/`). Modules declare their routes with their full paths (`/api/...`
 * for business endpoints, `/.well-known/...` for RFC-specified well-known
 * URIs) — the platform does NOT inject an `/api` prefix.
 *
 * Mount order: MUST be called BEFORE the SPA static fallback / `/*`
 * catch-all, otherwise the catch-all shadows every module-owned path.
 */
export function registerModuleRoutes(app: Hono<AppEnv>): void {
  for (const mod of _modules.values()) {
    const router = mod.createRouter?.();
    if (router) {
      app.route("/", router);
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

/**
 * Aggregate OIDC scopes contributed by every loaded module (excluding the
 * OIDC module itself, whose canonical vocabulary lives in
 * `modules/oidc/auth/scopes.ts`). The OIDC module reads this at boot via
 * `betterAuthPlugins()` so the aggregated list reaches:
 *   1. `oauthProvider({ scopes })` — feeds discovery `scopes_supported`
 *   2. `assertValidScopes` — gates `OIDC_INSTANCE_CLIENTS` registration
 *   3. `GET /api/oauth/scopes` — admin tooling
 *
 * Returns deduplicated entries in load order. Empty when no module
 * contributes — preserves the OSS zero-footprint invariant.
 */
export function getModuleOidcScopes(): string[] {
  const seen = new Set<string>();
  for (const mod of _modules.values()) {
    if (mod.manifest.id === "oidc") continue;
    for (const scope of mod.oidcScopes ?? []) {
      if (typeof scope === "string" && scope.length > 0) seen.add(scope);
    }
  }
  return Array.from(seen);
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
 * non-null resolution claims the request.
 *
 * OSS invariant: returns `[]` when no module provides `authStrategies()`.
 */
export function getModuleAuthStrategies(): AuthStrategy[] {
  const strategies: AuthStrategy[] = [];
  for (const mod of _modules.values()) {
    const contrib = mod.authStrategies?.();
    if (contrib) strategies.push(...contrib);
  }
  return strategies;
}

/**
 * Shape of the aggregated auth contributions that need to reach Better Auth
 * at `createAuth()` time: plugins (merged with `basePlugins`) and Drizzle
 * table definitions (merged into the adapter's model map so plugins like
 * `@better-auth/oauth-provider` can resolve their own tables).
 *
 * Both fields are erased to `unknown` at this layer — the boot integration
 * site in `packages/db/src/auth.ts` narrows to `BetterAuthPluginList` before
 * calling `createAuth(plugins, schemas)`. Keeps Better Auth types out of
 * core.
 */
export interface ModuleContributions {
  betterAuthPlugins: unknown[];
  drizzleSchemas: Record<string, unknown>;
}

/**
 * Aggregate Better Auth plugins and Drizzle schema tables from a list of
 * modules. The input is explicit so the production registry path and the
 * test preload path can share one implementation:
 *
 * - Production: `boot.ts` calls `collectModuleContributions(Array.from(getModules().values()))`
 *   after `loadModules()` has populated the singleton registry.
 * - Tests: `test/setup/preload.ts` imports modules off disk into a local
 *   array and calls this helper directly — it cannot use
 *   `getModules()` because the preload builds the Better Auth singleton
 *   before `getTestApp()` / `loadModulesFromInstances()` has run.
 *
 * OSS invariant: returns `{ betterAuthPlugins: [], drizzleSchemas: {} }`
 * when no module contributes.
 */
export function collectModuleContributions(
  modules: readonly AppstrateModule[],
): ModuleContributions {
  const betterAuthPlugins: unknown[] = [];
  const drizzleSchemas: Record<string, unknown> = {};
  // Provenance map: model name → module id that contributed it. Enables a
  // clear error message at boot when two modules declare the same Drizzle
  // model. Without this guard, `Object.assign` silently overwrites the
  // first contribution and a Better Auth plugin's `findOne({ model })`
  // call resolves to the wrong table — a nasty class of silent override
  // that only surfaces at runtime on the hot path.
  const modelProvenance: Record<string, string> = {};
  for (const mod of modules) {
    const plugins = mod.betterAuthPlugins?.();
    if (plugins) betterAuthPlugins.push(...plugins);
    const schemas = mod.drizzleSchemas?.();
    if (schemas) {
      for (const modelName of Object.keys(schemas)) {
        const existing = modelProvenance[modelName];
        if (existing && existing !== mod.manifest.id) {
          throw new Error(
            `Duplicate Drizzle model "${modelName}" contributed by both "${existing}" and ` +
              `"${mod.manifest.id}". Two modules cannot expose the same Better Auth model name ` +
              `— the second contribution would silently overwrite the first and break plugin ` +
              `table resolution. Rename one of the models in the offending module's schema.ts.`,
          );
        }
        modelProvenance[modelName] = mod.manifest.id;
      }
      Object.assign(drizzleSchemas, schemas);
    }
  }
  return { betterAuthPlugins, drizzleSchemas };
}

/**
 * Production collector — aggregates contributions from every module that
 * has been loaded into the singleton registry. Thin wrapper around
 * `collectModuleContributions()` that reads from `_modules`.
 */
export function getModuleContributions(): ModuleContributions {
  return collectModuleContributions(Array.from(_modules.values()));
}

/**
 * Merge module feature flags into the base AppConfig.
 * Each module's `features` is a `Record<string, boolean>` merged via `Object.assign`.
 */
export async function applyModuleFeatures(base: AppConfig): Promise<AppConfig> {
  const moduleFeatures: Record<string, boolean> = {};
  let config = { ...base };
  for (const mod of _modules.values()) {
    if (mod.features) Object.assign(moduleFeatures, mod.features);
    if (mod.appConfigContribution) {
      const contribution = await mod.appConfigContribution();
      config = { ...config, ...contribution };
    }
  }
  return {
    ...config,
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
 * no dependencies keep the order they appear in `MODULES`.
 *
 * Example: `MODULES=cloud,quota` — if both provide `beforeRun`,
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
  clearAllState();
}

/** Reset all state. Exported for tests only (skips `mod.shutdown`). */
export function resetModules(): void {
  clearAllState();
}

function clearAllState(): void {
  _modules.clear();
  _builtinCache = null;
  _initialized = false;
  setModulePermissionsProvider(null);
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
