// SPDX-License-Identifier: Apache-2.0

/**
 * Model Providers — runtime execution registry.
 *
 * Single source of truth for every LLM model provider Appstrate knows
 * about at runtime. The registry is **populated at boot** from module
 * contributions: every loaded module's `modelProviders()` hook is
 * collected and registered here. The three core API-key providers (openai,
 * anthropic, openai-compatible) ship as the `core-providers` module;
 * OAuth-flavoured providers ship as opt-in workspace modules
 * (`@appstrate/module-*`) or external npm specifiers. There is no in-code
 * seed.
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
import { hasCatalog, lookupCatalogModel } from "../pricing-catalog.ts";

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
  if (_byId.has(def.providerId)) {
    throw new Error(
      `Model provider ${JSON.stringify(def.providerId)} is already registered. ` +
        `Provider ids must be unique — the second definition would silently shadow the first.`,
    );
  }
  validateCatalogReferences(def);
  _byId.set(def.providerId, def);
}

/**
 * Loud boot-time check that every id declared in `featuredModels` exists
 * in the resolved catalog (`catalogProviderId ?? providerId`). The
 * vendored pricing catalog is the single source of truth for per-model
 * metadata — a typo or stale id here would silently render with
 * `contextWindow: 0` and `cost: null`, so we fail fast.
 *
 * Providers with no own catalog AND no `catalogProviderId` are allowed
 * IFF `featuredModels` is empty (openrouter, openai-compatible).
 */
function validateCatalogReferences(def: ModelProviderDefinition): void {
  const catalogKey = def.catalogProviderId ?? def.providerId;
  const catalogExists = hasCatalog(catalogKey);

  if (def.featuredModels.length > 0 && !catalogExists) {
    throw new Error(
      `Model provider ${JSON.stringify(def.providerId)} declares featuredModels ` +
        `but no catalog exists for ${JSON.stringify(catalogKey)}. ` +
        `Either drop the featured list or set catalogProviderId to a catalogued provider.`,
    );
  }

  if (catalogExists) {
    for (const modelId of def.featuredModels) {
      if (!lookupCatalogModel(catalogKey, modelId)) {
        throw new Error(
          `Model provider ${JSON.stringify(def.providerId)} features ` +
            `${JSON.stringify(modelId)} which is not in the ${catalogKey} catalog. ` +
            `Featured ids must exist in the catalog — drop the entry or add it via the refresh script.`,
        );
      }
    }
  }
}

/**
 * Bulk-register from a contribution array (e.g. `getModuleModelProviders()`).
 * Each entry goes through `registerModelProvider()`.
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
