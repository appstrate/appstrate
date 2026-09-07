// SPDX-License-Identifier: Apache-2.0

/**
 * Served-model metadata — what we know about a model id an endpoint serves.
 *
 * A custom OpenAI-compatible endpoint enumerates bare ids, so the vendored
 * pricing catalog is the only place a label, a context window or a capability
 * set can come from. Lookup order: the provider's own catalog
 * (`catalogProviderId ?? providerId`), then every vendored catalog by exact
 * id, then every catalog by the id with one leading `<vendor>/` segment
 * stripped (`openai/gpt-4o` → `gpt-4o`, the shape gateways publish). First hit
 * wins; a miss describes nothing rather than guessing.
 *
 * Cost is DELIBERATELY never returned. A self-hosted or third-party endpoint
 * serving a vendor's model id is not billed at the vendor's rate, so a price
 * carried over from the catalog would silently corrupt the usage ledger
 * (`llm_usage`). An absent cost is a visible gap; a wrong one is not.
 */

import type { CatalogModelEntry } from "@appstrate/shared-types";
import { listCatalogProviderIds, lookupCatalogModel } from "../pricing-catalog.ts";
import { getModelProvider } from "./registry.ts";

/** Catalog capabilities that describe what the model accepts as input. */
const INPUT_MODALITIES = new Set(["text", "image"]);

/** Everything the catalog can tell us about a served id, minus its price. */
interface ServedModelDescription {
  label: string | null;
  contextWindow: number | null;
  maxTokens: number | null;
  /** Accepted input modalities — the `text`/`image` subset of the capabilities. */
  input: string[] | null;
  reasoning: boolean | null;
}

function describe(entry: CatalogModelEntry): ServedModelDescription {
  return {
    label: entry.label,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    input: entry.capabilities.filter((c) => INPUT_MODALITIES.has(c)),
    reasoning: entry.capabilities.includes("reasoning"),
  };
}

/** Strip one leading `<vendor>/` segment; null when the id carries none. */
function stripVendorPrefix(modelId: string): string | null {
  const slash = modelId.indexOf("/");
  return slash > 0 && slash < modelId.length - 1 ? modelId.slice(slash + 1) : null;
}

/** Describe `modelId` as served by `providerId`, or all-null on a catalog miss. */
export function describeServedModel(providerId: string, modelId: string): ServedModelDescription {
  const ownCatalog = getModelProvider(providerId)?.catalogProviderId ?? providerId;
  const own = lookupCatalogModel(ownCatalog, modelId);
  if (own) return describe(own);

  const catalogIds = listCatalogProviderIds();
  for (const catalogId of catalogIds) {
    const entry = lookupCatalogModel(catalogId, modelId);
    if (entry) return describe(entry);
  }

  const stripped = stripVendorPrefix(modelId);
  if (stripped !== null) {
    for (const catalogId of catalogIds) {
      const entry = lookupCatalogModel(catalogId, stripped);
      if (entry) return describe(entry);
    }
  }

  return { label: null, contextWindow: null, maxTokens: null, input: null, reasoning: null };
}
