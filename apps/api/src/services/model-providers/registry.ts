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
 * refresh worker) MUST go through this registry — never reach into a
 * module's internal state directly. The provider id is the only stable
 * identifier between the DB row and the runtime.
 *
 * Why a runtime registry and not "ask the module loader each time": the
 * loader returns a fresh array on each call (collation across all
 * modules); the runtime registry indexes by id and stays cheap. Also,
 * future contributors can register providers programmatically without
 * being modules (e.g. test fixtures, ad-hoc OEM bundles) by calling
 * `registerModelProvider()` directly.
 */

import type { ModelProviderDefinition } from "@appstrate/core/module";
import { isAliasClientShape } from "@appstrate/core/model-swap";
import { LLM_PROXY_ROUTES, isProxiedApiShape } from "@appstrate/runner-pi/llm-proxy-routes";
import { listCatalogModels, lookupCatalogModel, piProviderOf } from "../model-catalog.ts";

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
 * tables and Better Auth model names.
 *
 * Also throws when an `authMode: "oauth2"` provider omits
 * `modelDiscovery: { mode: "static" }` — see {@link assertSubscriptionNeverEnumerated} —
 * when an api-key provider's shape is not one the LLM proxy serves — see
 * {@link assertApiKeyShapeProxied} — and when any provider declares the alias
 * client dialect — see {@link assertNotAliasClientShape}.
 */
export function registerModelProvider(def: ModelProviderDefinition): void {
  if (_byId.has(def.providerId)) {
    throw new Error(
      `Model provider ${JSON.stringify(def.providerId)} is already registered. ` +
        `Provider ids must be unique — the second definition would silently shadow the first.`,
    );
  }
  assertSubscriptionNeverEnumerated(def);
  assertApiKeyShapeProxied(def);
  assertNotAliasClientShape(def);
  validateCatalogReferences(def);
  assertInferenceProbeable(def);
  _byId.set(def.providerId, def);
}

/**
 * An oauth2 credential is a subscription token, and
 * `docs/architecture/SUBSCRIPTION_COMPLIANCE.md` allows no platform-side
 * request on one. Only `modelDiscovery: { mode: "static" }` keeps the listing
 * path from sending it upstream, so declaring it is checked at boot.
 */
function assertSubscriptionNeverEnumerated(def: ModelProviderDefinition): void {
  if (def.authMode === "oauth2" && def.modelDiscovery?.mode !== "static") {
    throw new Error(
      `Model provider ${JSON.stringify(def.providerId)} is an oauth2 (subscription) provider ` +
        `and must declare modelDiscovery: { mode: "static" }. A subscription provider's models ` +
        `are never enumerated by the platform — without it, model discovery would spend the ` +
        `user's access token on an upstream model listing.`,
    );
  }
}

/**
 * Every api-key model, platform-provided or an org's own, is served to runs by
 * the LLM proxy, so an api-key provider's shape must be one the proxy routes.
 */
function assertApiKeyShapeProxied(def: ModelProviderDefinition): void {
  if (def.authMode === "api_key" && !isProxiedApiShape(def.apiShape)) {
    throw new Error(
      `Model provider ${JSON.stringify(def.providerId)} is an api_key provider on apiShape ` +
        `${JSON.stringify(def.apiShape)}, which the platform LLM proxy does not serve ` +
        `(served: ${Object.keys(LLM_PROXY_ROUTES).join(", ")}).`,
    );
  }
}

/**
 * `pi-messages` is what an aliased run's container speaks to its sidecar, never
 * a vendor protocol, whatever the auth mode.
 */
function assertNotAliasClientShape(def: ModelProviderDefinition): void {
  if (isAliasClientShape(def.apiShape)) {
    throw new Error(
      `Model provider ${JSON.stringify(def.providerId)} declares apiShape ` +
        `${JSON.stringify(def.apiShape)}, the client dialect of aliased runs — not a vendor ` +
        `protocol a provider can serve.`,
    );
  }
}

/** `validateKeyByInference` speaks `openai-completions` and calls a model of the offer. */
function assertInferenceProbeable(def: ModelProviderDefinition): void {
  if (!def.publicModelListing) return;
  if (def.apiShape !== "openai-completions") {
    throw new Error(
      `Model provider ${JSON.stringify(def.providerId)} declares publicModelListing on ` +
        `apiShape ${JSON.stringify(def.apiShape)}; the inference probe that replaces the listing ` +
        `speaks openai-completions only.`,
    );
  }
  if (listCatalogModels(def).length === 0) {
    throw new Error(
      `Model provider ${JSON.stringify(def.providerId)} declares publicModelListing but its ` +
        `offer is empty; the inference probe needs a model to call.`,
    );
  }
}

/**
 * Boot-time check that every featured id is in the provider's offer (Pi's
 * records of its Pi provider on its `apiShape`). Pi's registry is pinned with
 * the SDK version, so a failure here is a declaration error (or a deliberate
 * Pi bump dropping a model), never refreshed data.
 */
function validateCatalogReferences(def: ModelProviderDefinition): void {
  for (const modelId of def.featuredModels) {
    if (!lookupCatalogModel(def, modelId)) {
      throw new Error(
        `Model provider ${JSON.stringify(def.providerId)} features ${JSON.stringify(modelId)}, ` +
          `which is not in its offer (Pi provider ${JSON.stringify(piProviderOf(def))} on ` +
          `${JSON.stringify(def.apiShape)}). Featured ids must be offered — drop the entry.`,
      );
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
