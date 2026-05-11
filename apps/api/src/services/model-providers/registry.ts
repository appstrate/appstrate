// SPDX-License-Identifier: Apache-2.0

/**
 * Model Providers — runtime execution registry.
 *
 * Single source of truth for every LLM model provider Appstrate knows
 * about at runtime. The registry is **populated at boot** from two
 * sources:
 *   1. Module contributions — every loaded module's `modelProviders()`
 *      hook is collected and registered here.
 *   2. The legacy in-code seed (`oauth-model-providers/registry.ts`) —
 *      kept transitional until PR 4-5 move the built-in providers into
 *      dedicated modules.
 *
 * Lookups during the request hot path (token resolver, llm-proxy,
 * sidecar `/configure`, refresh worker) MUST go through this registry —
 * never reach into a module's internal state directly. The provider id
 * is the only stable identifier between the DB row and the runtime.
 *
 * Why a runtime registry and not "ask the module loader each time": the
 * loader returns a fresh array on each call (collation across all
 * modules); the runtime registry indexes by id and stays cheap. Also,
 * future contributors can register providers programmatically without
 * being modules (e.g. test fixtures, ad-hoc OEM bundles) by calling
 * `registerModelProvider()` directly.
 */

import type { ModelProviderDefinition } from "@appstrate/core/module";
import { getEnv } from "@appstrate/env";

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

const _byId = new Map<string, ModelProviderDefinition>();

// ---------------------------------------------------------------------------
// Registration (called at boot — must be idempotent within a single process)
// ---------------------------------------------------------------------------

/**
 * Register one model provider definition.
 *
 * Throws on duplicate `providerId`. Provider ids must be globally unique
 * because they identify DB credential rows; a silent overwrite would mean
 * one of the two definitions is unreachable at lookup time, which is
 * exactly the class of bug the module-loader guards against for Drizzle
 * tables and appScopedPaths.
 */
export function registerModelProvider(def: ModelProviderDefinition): void {
  const existing = _byId.get(def.providerId);
  if (existing && existing !== def) {
    throw new Error(
      `Model provider ${JSON.stringify(def.providerId)} is already registered. ` +
        `Provider ids must be unique — the second definition would silently shadow the first.`,
    );
  }
  _byId.set(def.providerId, def);
}

/**
 * Bulk-register from a contribution array (e.g. `getModuleModelProviders()`
 * or the legacy seed). Each entry goes through `registerModelProvider()`.
 */
export function registerModelProviders(defs: readonly ModelProviderDefinition[]): void {
  for (const def of defs) registerModelProvider(def);
}

/**
 * Reset the registry. **Test-only** — never called in production. The
 * module loader has its own `resetModules()`; this is its model-provider
 * counterpart for unit tests that reuse the registry across cases.
 */
export function resetModelProviders(): void {
  _byId.clear();
}

// ---------------------------------------------------------------------------
// Lookups (runtime hot path — keep O(1))
// ---------------------------------------------------------------------------

/** Returns the runtime config for a model provider, or null if unknown. */
export function getModelProvider(providerId: string): ModelProviderDefinition | null {
  return _byId.get(providerId) ?? null;
}

/** True iff the id resolves to an OAuth model provider. */
export function isOAuthModelProvider(providerId: string): boolean {
  const def = _byId.get(providerId);
  return def?.authMode === "oauth2";
}

/** Iterate all registered model providers (insertion order). */
export function listModelProviders(): readonly ModelProviderDefinition[] {
  return Array.from(_byId.values());
}

/**
 * True iff `providerId` is registered AND NOT listed in `MODEL_PROVIDERS_DISABLED`.
 *
 * "Soft disable" — admin-facing surfaces (UI picker, POST creation, OAuth
 * initiate) consult this check; the runtime hot path (token-resolver,
 * refresh-worker, llm-proxy, `executeProviderCall`) deliberately uses the
 * unfiltered accessors so existing credentials for a disabled provider
 * keep working until the admin deletes them.
 */
export function isModelProviderEnabled(providerId: string): boolean {
  if (!_byId.has(providerId)) return false;
  return !getEnv().MODEL_PROVIDERS_DISABLED.includes(providerId);
}

/**
 * Iterate the subset of registered model providers that are enabled by env.
 *
 * Use this in admin/UI surfaces where disabled providers must NOT appear.
 * Use `listModelProviders()` for any runtime resolver that must keep
 * operating on existing credentials.
 */
export function listEnabledModelProviders(): readonly ModelProviderDefinition[] {
  return listModelProviders().filter((p) => isModelProviderEnabled(p.providerId));
}

/** Provider ids known at this moment — used by the boot env validator. */
export function getRegisteredProviderIds(): readonly string[] {
  return Array.from(_byId.keys());
}
