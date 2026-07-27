// SPDX-License-Identifier: Apache-2.0

import type { Hono } from "hono";
import type { AppConfig } from "@appstrate/shared-types";
import type {
  AppstrateModule,
  BroadcastHooks,
  FirstMatchHooks,
  ModelProviderDefinition,
  ModuleInitContext,
  ModuleHooks,
  ModuleEvents,
  AuthStrategy,
  ModulePermissionContribution,
} from "@appstrate/core/module";
import { CORE_VERSION } from "@appstrate/core/module";
import { getErrorMessage } from "@appstrate/core/errors";
import { isValidRange, matchVersion } from "@appstrate/core/semver";
import { getEnv } from "@appstrate/env";
import {
  CORE_RESOURCE_NAMES,
  setModulePermissionsProvider,
  type OrgRole,
  type ModulePermissionsSnapshot,
} from "@appstrate/core/permissions";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import type { AppEnv } from "../../types/index.ts";
import { logger } from "../logger.ts";
import { setPlatformApp } from "../platform-app.ts";
import {
  registerOrchestrator,
  _resetOrchestratorRegistryForTesting,
} from "../../services/orchestrator/registry.ts";

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

  // Walk every `<moduleId>/index.ts` under `modules/` in a single Bun.Glob
  // pass — implicitly handles missing directory, non-directory entries, and
  // missing index.ts. Replaces three node:fs sync calls (Bun-native runtime).
  const glob = new Bun.Glob("*/index.ts");
  for (const match of glob.scanSync({ cwd: modulesDir, onlyFiles: true })) {
    const moduleId = match.split("/")[0];
    if (!moduleId) continue;
    cache.set(moduleId, join(modulesDir, match));
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

/**
 * Import one module specifier and return its exported module object. Any
 * failure (unresolvable specifier, missing `manifest.id`) is fatal — all
 * declared modules are required.
 */
async function importModule(specifier: string): Promise<AppstrateModule> {
  try {
    const raw = await resolveSpecifier(specifier);
    // Support both default export and named `appstrateModule` export
    const mod = (raw.default ?? raw.appstrateModule) as AppstrateModule | undefined;
    if (!mod?.manifest?.id) {
      throw new Error(`Module "${specifier}" is missing manifest.id`);
    }
    return mod;
  } catch (err) {
    throw new Error(`Module "${specifier}" could not be loaded: ${getErrorMessage(err)}`, {
      cause: err,
    });
  }
}

// ---------------------------------------------------------------------------
// Core-version contract guard (issue #973)
// ---------------------------------------------------------------------------

const CORE_PACKAGE = "@appstrate/core";

/**
 * Dependency protocols that mean "resolved from this workspace, not npm". Such
 * a module compiles against the very core it will run on, so `tsc` already
 * gates it — there is nothing for a semver check to add.
 */
const IN_TREE_RANGE_PREFIXES = ["workspace:", "link:", "file:"];

/**
 * Read the `@appstrate/core` range an npm-loaded module declares in its own
 * `package.json`. `import.meta.resolve` yields the module's entry file (the
 * same resolution {@link resolveSpecifier} performs), and a package's root is
 * by definition the nearest ancestor directory carrying a `package.json`.
 *
 * Best-effort by design: an unresolvable specifier, an unreadable file or a
 * missing entry all mean "unknown", never a crash — this guard must not be the
 * thing that stops a working module from booting.
 */
async function coreRangeFromPackageJson(specifier: string): Promise<string | null> {
  try {
    let dir = dirname(fileURLToPath(import.meta.resolve(specifier)));
    // Bounded walk: a package root is a handful of levels above its entry file
    // at most, and an unbounded loop would climb out of the repo.
    for (let depth = 0; depth < 10; depth++) {
      const file = Bun.file(join(dir, "package.json"));
      if (await file.exists()) {
        const pkg = (await file.json()) as {
          dependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        return (
          pkg.dependencies?.[CORE_PACKAGE] ??
          pkg.peerDependencies?.[CORE_PACKAGE] ??
          pkg.devDependencies?.[CORE_PACKAGE] ??
          null
        );
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Unresolvable — falls through to "unknown" (warned by the caller).
  }
  return null;
}

/**
 * Resolve the `@appstrate/core` range a module declares, in precedence order:
 * the manifest field, then the module's own package.json for an npm specifier.
 * A built-in module is in-tree by construction, so it short-circuits to the
 * workspace protocol instead of a filesystem lookup.
 */
async function resolveDeclaredCoreRange(
  mod: AppstrateModule,
  specifier: string | null,
): Promise<string | null> {
  if (mod.manifest.core_version) return mod.manifest.core_version;
  if (specifier === null) return null; // instance-loaded: the manifest is the only source
  if (getBuiltinModules().has(specifier)) return "workspace:*";
  return coreRangeFromPackageJson(specifier);
}

/**
 * Boot guard on the module→platform direction of the contract (#973).
 *
 * `tsc` cannot see an out-of-tree module, and the platform's `PlatformServices`
 * surface changes shape between majors: `checkUsageAllowed` gained a REQUIRED
 * `subscription` flag in core 6.0.0, and a 5.x-era caller that omits it does
 * not error — it silently reports a subscription turn as platform-funded. So a
 * declared-but-unsatisfied range is fatal by default; the operator running a
 * lagging third-party module can downgrade to a warning with
 * `MODULE_CONTRACT_ENFORCE=warn`.
 */
async function enforceCoreVersionContract(
  mod: AppstrateModule,
  specifier: string | null,
): Promise<void> {
  const id = mod.manifest.id;
  const declared = await resolveDeclaredCoreRange(mod, specifier);

  if (declared !== null && IN_TREE_RANGE_PREFIXES.some((p) => declared.startsWith(p))) {
    logger.debug("Module resolves @appstrate/core from the workspace, skipping version gate", {
      id,
      declared,
    });
    return;
  }
  if (declared === null || !isValidRange(declared)) {
    logger.warn("Module declares no usable @appstrate/core range — version contract unverified", {
      id,
      declared,
      coreVersion: CORE_VERSION,
    });
    return;
  }
  // `matchVersion` is the satisfies check: the running core is the only
  // candidate, so a null result means the range excludes it.
  if (matchVersion([CORE_VERSION], declared) !== null) return;

  const message =
    `Module "${id}" was built against ${CORE_PACKAGE} ${declared}, but this platform ships ` +
    `${CORE_VERSION}. Republish the module against ${CORE_VERSION}, or set ` +
    `MODULE_CONTRACT_ENFORCE=warn to boot anyway (a stale module can call a platform service ` +
    `whose signature moved under it — silently, without an error).`;
  if (getEnv().MODULE_CONTRACT_ENFORCE === "warn") {
    logger.warn(message, { id, declared, coreVersion: CORE_VERSION });
    return;
  }
  throw new Error(message);
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
    const mod = await importModule(specifier);
    // Version gate lives outside `importModule`: a core-version mismatch is not
    // an import failure, and its message already names the module — wrapping it
    // in "could not be loaded" would say it twice.
    await enforceCoreVersionContract(mod, specifier);
    resolved.push(mod);
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
  // Same gate as the specifier path — a pre-resolved instance still carries its
  // manifest, and the guard must not be something the entry point decides.
  // There is no specifier here, so `manifest.core_version` is the only source.
  for (const mod of modules) await enforceCoreVersionContract(mod, null);
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
  // Compute the RBAC snapshot from module contributions and register it
  // BEFORE init() runs, so any module that calls `resolvePermissions(...)`
  // during init (e.g. seeding default API keys with module-owned scopes)
  // sees the merged view.
  const rbacSnapshot = collectModulePermissions(sorted);
  setModulePermissionsProvider(() => rbacSnapshot);
  // Audit trace: `endUserGrantable` permissions are reachable through
  // end-user OAuth/OIDC tokens issued by embedding apps — a much broader
  // blast radius than session or API-key scopes. Surface the full list at
  // boot so operators can review in a single log line whether a new
  // external module opted anything risky in. Silent when no module opted
  // in (OSS baseline, OIDC+webhooks only).
  if (rbacSnapshot.endUserAllowed.size > 0) {
    logger.info("Module contributions reachable via end-user OIDC tokens", {
      count: rbacSnapshot.endUserAllowed.size,
      scopes: [...rbacSnapshot.endUserAllowed].sort(),
    });
  }
  for (const mod of sorted) {
    try {
      await mod.init(ctx);
    } catch (err) {
      throw new Error(`Module "${mod.manifest.id}" failed to initialize: ${getErrorMessage(err)}`, {
        cause: err,
      });
    }
    if (_modules.has(mod.manifest.id)) {
      logger.warn("Duplicate module ID, overwriting", { id: mod.manifest.id });
    }
    // Execution backends must be registered before anything resolves
    // RUN_ADAPTER (first `getOrchestrator()` happens later in boot).
    // `registerOrchestrator` throws on a duplicate id — fatal, same
    // uniqueness posture as model providers.
    const orchestrators = mod.orchestrators?.();
    if (orchestrators) {
      for (const [id, registration] of Object.entries(orchestrators)) {
        registerOrchestrator(id, registration, mod.manifest.id);
      }
    }
    _modules.set(mod.manifest.id, mod);
    logger.info("Module loaded", { id: mod.manifest.id, version: mod.manifest.version });
  }
  _initialized = true;
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
  const endUserAllowed = new Set<string>();
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
        if (entry.endUserGrantable) endUserAllowed.add(perm);
      }
    }
  }

  return { byRole, apiKeyAllowed, endUserAllowed };
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
  // Expose the fully-wired app so modules can issue authenticated in-process
  // requests back through the platform (e.g. the `mcp` module re-enters via
  // `app.fetch` to reuse the auth pipeline + RBAC). Generic capability — set
  // here because this is the single production site where every route
  // (core + module) is mounted on one app instance.
  setPlatformApp(app);
  for (const mod of _modules.values()) {
    const router = mod.createRouter?.();
    if (router) {
      app.route("/", router);
    }
  }
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
 * Aggregate model provider definitions contributed by every loaded module.
 *
 * Order: module init order (topological). When two modules contribute a
 * provider with the same `providerId`, this throws — there is no
 * first-match-wins fallback. Provider ids must be globally unique because
 * the platform stores them as `provider_id` strings in DB rows and
 * resolves credentials by id.
 *
 * OSS invariant: returns `[]` when no module contributes (e.g. cloud SaaS
 * with `MODULES=oidc,webhooks` and no provider-contributing module loaded).
 */
export function getModuleModelProviders(): readonly ModelProviderDefinition[] {
  const collected: ModelProviderDefinition[] = [];
  const ownerById = new Map<string, string>();
  for (const mod of _modules.values()) {
    const contrib = mod.modelProviders?.();
    if (!contrib) continue;
    for (const def of contrib) {
      const previous = ownerById.get(def.providerId);
      if (previous && previous !== mod.manifest.id) {
        throw new Error(
          `Modules "${previous}" and "${mod.manifest.id}" both declared model provider ` +
            `${JSON.stringify(def.providerId)}. Provider ids must be unique across loaded modules ` +
            `— credentials are stored by provider_id and the second contribution would silently ` +
            `shadow the first at lookup time.`,
        );
      }
      ownerById.set(def.providerId, mod.manifest.id);
      collected.push(def);
    }
  }
  return collected;
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
 * Shape of the aggregated auth contributions that need to reach Better Auth at
 * `createAuth()` time. Plugins are the only contribution: a module owns no
 * tables, so the Drizzle adapter resolves every table from the core barrel and
 * no per-module schema map is passed.
 *
 * `betterAuthPlugins` is erased to `unknown` at this layer — the boot
 * integration site in `packages/db/src/auth.ts` narrows to
 * `BetterAuthPluginList` before calling `createAuth(plugins)`. Keeps Better
 * Auth types out of core.
 */
interface ModuleContributions {
  betterAuthPlugins: unknown[];
}

/**
 * Aggregate Better Auth plugins from an explicit list of modules. The input is
 * a parameter (rather than the singleton registry) so the production path and
 * the test preload path share one implementation:
 *
 * - Production: `boot.ts` calls the {@link getModuleContributions} wrapper,
 *   which feeds this function from the singleton registry populated by
 *   `loadModules()`.
 * - Tests: `test/setup/preload.ts` imports modules off disk into a local array
 *   and calls this function directly.
 *
 * OSS invariant: returns `{ betterAuthPlugins: [] }` when no module contributes.
 */
export function collectModuleContributions(
  modules: readonly AppstrateModule[],
): ModuleContributions {
  const betterAuthPlugins: unknown[] = [];
  for (const mod of modules) {
    const plugins = mod.betterAuthPlugins?.();
    if (plugins) betterAuthPlugins.push(...plugins);
  }
  return { betterAuthPlugins };
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

// Internal type: hooks/events objects cast to indexable records for dynamic dispatch.
// The public types (ModuleHooks/ModuleEvents) are strict — this cast is only used
// inside the loader where dispatch is inherently dynamic (by hook/event name).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (...args: any[]) => any;

/** Unwrap the Promise return type of a hook. */
type HookResult<K extends keyof ModuleHooks> = Awaited<ReturnType<ModuleHooks[K]>>;

/**
 * Call a FIRST-MATCH-WINS hook ({@link FirstMatchHooks}) — returns the result
 * from the FIRST module that provides it, or `undefined` if no module does.
 *
 * Modules are iterated in topological init order. If the first module that
 * provides the hook returns a value (including `null`), subsequent modules are
 * never consulted. Load order (`manifest.dependencies` topological sort)
 * defines priority — modules with no dependencies keep the order they appear
 * in `MODULES`.
 *
 * Example: `MODULES=admission,metering` — if both provide `beforeUsage`,
 * `admission` runs first. To force ordering regardless of env order, add
 * `dependencies: ["admission"]` on `metering` so the topo sort always places
 * `admission` earlier.
 *
 * Broadcast hooks are NOT callable here (the signature rejects them): use
 * {@link callAllHooks}. For side-effect-only fan-out, use {@link emitEvent}.
 */
export async function callHook<K extends keyof FirstMatchHooks>(
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

/**
 * Broadcast a {@link BroadcastHooks} hook to EVERY loaded module (vs
 * {@link callHook}'s first-match-wins). These are the gates whose semantics are
 * "every module participates" — `beforeSignup` / `afterSignup`, where a
 * metering module's free-tier gate AND the OIDC per-client signup policy both
 * must run on each signup. Errors PROPAGATE (unlike {@link emitEvent}): a
 * throwing `beforeSignup` aborts user creation, which is the gate's whole
 * purpose.
 *
 * First-match hooks are NOT callable here (the signature rejects them):
 * broadcasting `beforeUsage` would discard every rejection but the last.
 */
export async function callAllHooks<K extends keyof BroadcastHooks>(
  name: K,
  ...args: Parameters<ModuleHooks[K]>
): Promise<void> {
  for (const mod of _modules.values()) {
    const hook = (mod.hooks as Record<string, AnyHandler> | undefined)?.[name];
    if (hook) await hook(...args);
  }
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
          error: getErrorMessage(err),
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
        error: getErrorMessage(err),
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
  // Drop module-contributed execution backends so a reload (tests) does not
  // trip the duplicate-id guard. Core backends are re-registered inside.
  _resetOrchestratorRegistryForTesting();
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
      // A declared dependency is a hard peer requirement, not a soft ordering
      // hint: if it isn't among the loaded modules the dependent cannot work
      // (e.g. `chat` without `mcp` is a no-tools shadow product). Fail boot with
      // a clear config error instead of silently degrading.
      if (!byId.has(dep)) {
        throw new Error(
          `Module "${id}" requires module "${dep}", which is not loaded. Add "${dep}" to MODULES.`,
        );
      }
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
