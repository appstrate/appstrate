// SPDX-License-Identifier: Apache-2.0

/**
 * Vendored model catalog — phase 2 + phase 6 of #437. Sourced from
 * [BerriAI/litellm](https://github.com/BerriAI/litellm) (MIT, weekly
 * upstream refresh by `scripts/refresh-pricing-catalog.ts`).
 *
 * Carries both **pricing** and **metadata** (context window, max output
 * tokens, capabilities, mode) per model. The catalog feeds:
 *
 *   - **The picker UI** (`/api/model-provider-credentials/registry` →
 *     {@link listCatalogModels}): every model the user can select.
 *     Editorial curation surfaces via `featuredModelIds` on the provider
 *     definition (small whitelist) — the rest live under "All models".
 *   - **The cost ledger** (`org-models.ts`): fills `cost` on any
 *     `org_models` row whose explicit `cost` override is null via
 *     `lookupCatalogModel(...)?.cost`. Same semantics for system models
 *     loaded from `SYSTEM_PROVIDER_KEYS`.
 *
 * Why vendor (vs runtime fetch):
 *   - Boot must not depend on a remote URL — Tier 0 self-hosting works
 *     offline.
 *   - Pricing changes are infrequent enough that a weekly CI bump beats
 *     a 99.9% network dependency every container boot.
 *   - Vendoring also pins data to the deployed code revision —
 *     mid-quarter price drops can't silently change historical cost
 *     attribution.
 *
 * Refresh: `bun run scripts/refresh-pricing-catalog.ts --apply`.
 *
 * The lookup is keyed on **providerId** (not `apiShape`): cerebras,
 * groq, and xai all share `openai-completions` apiShape with different
 * upstreams + different pricing, so the wire format alone can't
 * disambiguate. `providerId` is the natural fan-out key — it matches a
 * single `ModelProviderDefinition` and a single vendored JSON file.
 */

import type { ModelCost } from "@appstrate/core/module";
import openaiPricing from "../data/pricing/openai.json" with { type: "json" };
import anthropicPricing from "../data/pricing/anthropic.json" with { type: "json" };
import mistralPricing from "../data/pricing/mistral.json" with { type: "json" };
import googlePricing from "../data/pricing/google-ai.json" with { type: "json" };
import cerebrasPricing from "../data/pricing/cerebras.json" with { type: "json" };
import groqPricing from "../data/pricing/groq.json" with { type: "json" };
import xaiPricing from "../data/pricing/xai.json" with { type: "json" };

/**
 * Compact model entry — the projection emitted by the refresh script.
 * Mirrors the JSON shape exactly. Read-only at runtime.
 */
export interface CatalogModel {
  /** Display label derived from the id at vendoring time (title-cased). */
  label: string;
  /** Maximum input context window in tokens. */
  contextWindow: number;
  /** Maximum response tokens (provider-defined ceiling). May be null. */
  maxTokens: number | null;
  /** Capabilities surfaced for selection UIs. */
  capabilities: readonly string[];
  /** Per-1M-token cost (USD). Always present — entries without pricing are dropped at vendoring. */
  cost: ModelCost;
}

/**
 * Catalog index keyed on `providerId`. Adding a JSON under
 * `apps/api/src/data/pricing/<providerId>.json` requires wiring it
 * here AND ensuring the `ModelProviderDefinition.providerId` matches
 * the filename — otherwise the lookup silently misses.
 */
const PROVIDER_INDEX: Record<string, Record<string, CatalogModel>> = {
  openai: openaiPricing as Record<string, CatalogModel>,
  anthropic: anthropicPricing as Record<string, CatalogModel>,
  mistral: mistralPricing as Record<string, CatalogModel>,
  "google-ai": googlePricing as Record<string, CatalogModel>,
  cerebras: cerebrasPricing as Record<string, CatalogModel>,
  groq: groqPricing as Record<string, CatalogModel>,
  xai: xaiPricing as Record<string, CatalogModel>,
};

/**
 * Return every catalogued model for a `providerId`. Callers wrap each
 * entry with provider context (apiShape, baseUrl, featured flag) before
 * exposing via the `/registry` endpoint.
 *
 * Returns an empty array when the provider is not vendored
 * (`openai-compatible`, `openrouter`, `codex`, …). Inline `models[]`
 * on the provider definition covers those cases.
 */
export function listCatalogModels(providerId: string): Array<CatalogModel & { id: string }> {
  const file = PROVIDER_INDEX[providerId];
  if (!file) return [];
  return Object.entries(file).map(([id, entry]) => ({ id, ...entry }));
}

/** True iff `providerId` has a vendored catalog file. Used at boot to gate `featuredModels` validation. */
export function hasCatalog(providerId: string): boolean {
  return providerId in PROVIDER_INDEX;
}

/**
 * Resolve a single `(providerId, modelId)` to its catalog entry.
 * Returns null on any miss — unmapped provider, unknown model id, or
 * entry stripped at vendoring time.
 */
export function lookupCatalogModel(providerId: string, modelId: string): CatalogModel | null {
  const file = PROVIDER_INDEX[providerId];
  if (!file) return null;
  return file[modelId] ?? null;
}

/** @internal test helper — total models indexed across all providers. */
export function _catalogSize(): number {
  return Object.values(PROVIDER_INDEX).reduce((acc, file) => acc + Object.keys(file).length, 0);
}
