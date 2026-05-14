// SPDX-License-Identifier: Apache-2.0

/**
 * Pricing catalog — phase 2 of #437. Vendored from
 * [Portkey-AI/models](https://github.com/Portkey-AI/models) (MIT, weekly
 * upstream refresh).
 *
 * Purpose: replace ad-hoc `org_models.cost` maintenance with an
 * always-available default. Manual `cost` JSONB on the row stays as an
 * **override** — when set, it wins; when null, we fall back to the
 * catalog. Same semantics for system models loaded from
 * `SYSTEM_PROVIDER_KEYS`.
 *
 * Why vendor (vs runtime fetch):
 *   - Boot must not depend on a remote URL — Tier 0 self-hosting works
 *     offline.
 *   - Pricing changes are infrequent enough that a weekly CI bump beats
 *     a 99.9% network dependency every container boot.
 *   - Vendoring also pins the data to the deployed code revision —
 *     mid-quarter price drops can't silently change historical cost
 *     attribution.
 *
 * Refresh: re-run `bun run scripts/refresh-pricing-catalog.ts` (added in
 * a follow-up commit); diffs land as a PR.
 *
 * Currency conversion: Portkey stores prices in **cents per token**.
 * Appstrate stores `ModelCost` in **USD per million tokens**:
 *
 *   usdPerMillion = centsPerToken × 1_000_000 / 100  // × 10_000
 *
 * The conversion is centralized in `convertPortkeyEntry()` below so the
 * vendored JSON stays in its native (Portkey) shape — diffing a new
 * upstream snapshot is a textual comparison.
 */

import type { ModelCost } from "@appstrate/core/module";
import openaiPricing from "../data/pricing/openai.json" with { type: "json" };
import anthropicPricing from "../data/pricing/anthropic.json" with { type: "json" };
import mistralPricing from "../data/pricing/mistral-ai.json" with { type: "json" };
import googlePricing from "../data/pricing/google.json" with { type: "json" };

/**
 * Appstrate canonical `apiShape` → Portkey provider slug. This is the
 * authoritative mapping for both pricing lookup AND Portkey routing
 * (`apps/api/src/modules/portkey/config.ts` re-exports + reuses it).
 * The subscription-OAuth shape `openai-codex-responses` is intentionally
 * absent — those calls bypass both the catalog and Portkey.
 */
export const API_SHAPE_TO_PORTKEY_PROVIDER: Record<string, string> = {
  "anthropic-messages": "anthropic",
  "openai-chat": "openai",
  "openai-completions": "openai",
  "openai-responses": "openai",
  "mistral-conversations": "mistral-ai",
  "google-generative-ai": "google",
  "google-vertex": "vertex-ai",
  "azure-openai-responses": "azure-openai",
  "bedrock-converse-stream": "bedrock",
};

/**
 * Portkey-side entry shape — narrowed to the fields we read. The
 * upstream JSON carries additional fields (`batch_config`,
 * `additional_units`, …) that we ignore today; surface them later if
 * batch pricing is exposed at the org level.
 */
interface PortkeyPricingEntry {
  pricing_config?: {
    pay_as_you_go?: {
      request_token?: { price: number };
      response_token?: { price: number };
      cache_read_input_token?: { price: number };
      cache_write_input_token?: { price: number };
    };
  };
}

type PortkeyProviderFile = Record<string, PortkeyPricingEntry>;

/** Index keyed on the Portkey provider slug. */
const PROVIDER_INDEX: Record<string, PortkeyProviderFile> = {
  openai: openaiPricing as PortkeyProviderFile,
  anthropic: anthropicPricing as PortkeyProviderFile,
  "mistral-ai": mistralPricing as PortkeyProviderFile,
  google: googlePricing as PortkeyProviderFile,
};

/**
 * Convert one Portkey entry to Appstrate `ModelCost`. Returns null when
 * the `pay_as_you_go` block is missing or has no `request_token` price
 * — happens for some models in the upstream catalog (e.g. embeddings
 * with token-free units, or placeholder entries).
 */
function convertPortkeyEntry(entry: PortkeyPricingEntry): ModelCost | null {
  const pay = entry.pricing_config?.pay_as_you_go;
  if (!pay?.request_token || !pay.response_token) return null;
  const cents2usd = 10_000;
  const out: ModelCost = {
    input: pay.request_token.price * cents2usd,
    output: pay.response_token.price * cents2usd,
  };
  if (pay.cache_read_input_token) {
    out.cacheRead = pay.cache_read_input_token.price * cents2usd;
  }
  if (pay.cache_write_input_token) {
    out.cacheWrite = pay.cache_write_input_token.price * cents2usd;
  }
  return out;
}

/**
 * Resolve `(apiShape, modelId)` → `ModelCost | null`. Returns null when
 * any of:
 *
 *   - `apiShape` has no Portkey provider mapping (e.g. exotic shapes,
 *     subscription-OAuth shapes that bypass billing)
 *   - the catalog has no entry for this `modelId` under the resolved
 *     provider (custom fine-tunes, brand-new releases not yet vendored)
 *   - the entry exists but lacks `pay_as_you_go.request_token` /
 *     `response_token`
 *
 * Callers (`org-models.ts`, `system providers`) treat null as
 * "no override AND no catalog hit → cost stays null on the resolved
 * model"; downstream `computeCostUsd()` then short-circuits to 0.
 */
export function lookupModelCost(apiShape: string, modelId: string): ModelCost | null {
  const provider = API_SHAPE_TO_PORTKEY_PROVIDER[apiShape];
  if (!provider) return null;
  const providerFile = PROVIDER_INDEX[provider];
  if (!providerFile) return null;
  const entry = providerFile[modelId];
  if (!entry) return null;
  return convertPortkeyEntry(entry);
}

/** @internal test helper — total models indexed across all providers. */
export function _catalogSize(): number {
  return Object.values(PROVIDER_INDEX).reduce((acc, file) => acc + Object.keys(file).length, 0);
}
