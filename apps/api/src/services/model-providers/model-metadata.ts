// SPDX-License-Identifier: Apache-2.0

/**
 * Served-model metadata — what we know about a model id an endpoint serves.
 *
 * Two sources, and the endpoint wins field by field: the hints its own listing
 * published ({@link ServedModelHints}, read by `model-listing.ts` from the
 * response already in hand), then the vendored pricing catalog for everything
 * the hints leave open — which, for a custom endpoint enumerating bare ids, is
 * usually everything. `label` is catalog-only: a listing entry names a model
 * for its own API, not for a picker. Catalog lookup order: the provider's own
 * catalog (`catalogProviderId ?? providerId`), then every vendored catalog by
 * exact id, then every catalog by the id with one leading `<vendor>/` segment
 * stripped (`openai/gpt-4o` → `gpt-4o`, the shape gateways publish). First hit
 * wins; a miss describes nothing rather than guessing.
 *
 * Cost is DELIBERATELY never returned. A self-hosted or third-party endpoint
 * serving a vendor's model id is not billed at the vendor's rate, so a price
 * carried over from the catalog would silently corrupt the usage ledger
 * (`llm_usage`). An absent cost is a visible gap; a wrong one is not.
 */

import type { CatalogModelEntry } from "@appstrate/shared-types";
import type { ServedModelHints } from "./model-listing.ts";
import { listCatalogProviderIds, lookupCatalogModel } from "../pricing-catalog.ts";
import { getModelProvider } from "./registry.ts";

/** Catalog capabilities that describe what the model accepts as input. */
const INPUT_MODALITIES = new Set(["text", "image"]);

/** Everything we can tell about a served id, minus its price. */
interface ServedModelDescription {
  label: string | null;
  contextWindow: number | null;
  maxTokens: number | null;
  /** Accepted input modalities — the `text`/`image` subset of the capabilities. */
  input: string[] | null;
  reasoning: boolean | null;
  /**
   * Where the description comes from: `endpoint` when the listing published at
   * least one field of it, `catalog` when it is a pure catalog hit, `null` when
   * nothing described the id.
   */
  source: "endpoint" | "catalog" | null;
}

/** Strip one leading `<vendor>/` segment; null when the id carries none. */
function stripVendorPrefix(modelId: string): string | null {
  const slash = modelId.indexOf("/");
  return slash > 0 && slash < modelId.length - 1 ? modelId.slice(slash + 1) : null;
}

/** The catalog entry describing `modelId` as served by `providerId`, if any. */
function lookupServedEntry(providerId: string, modelId: string): CatalogModelEntry | null {
  const ownCatalog = getModelProvider(providerId)?.catalogProviderId ?? providerId;
  const own = lookupCatalogModel(ownCatalog, modelId);
  if (own) return own;

  const catalogIds = listCatalogProviderIds();
  for (const catalogId of catalogIds) {
    const entry = lookupCatalogModel(catalogId, modelId);
    if (entry) return entry;
  }

  const stripped = stripVendorPrefix(modelId);
  if (stripped !== null) {
    for (const catalogId of catalogIds) {
      const entry = lookupCatalogModel(catalogId, stripped);
      if (entry) return entry;
    }
  }

  return null;
}

/**
 * Describe `modelId` as served by `providerId`. `hints` — what the endpoint's
 * own listing published — wins field by field; the catalog fills the rest, and
 * an id described by neither comes back all-null.
 */
export function describeServedModel(
  providerId: string,
  modelId: string,
  hints: ServedModelHints = {},
): ServedModelDescription {
  const entry = lookupServedEntry(providerId, modelId);
  const hinted = Object.values(hints).some((value) => value !== undefined);
  return {
    label: entry?.label ?? null,
    contextWindow: hints.contextWindow ?? entry?.contextWindow ?? null,
    maxTokens: hints.maxTokens ?? entry?.maxTokens ?? null,
    input: hints.input ?? entry?.capabilities.filter((c) => INPUT_MODALITIES.has(c)) ?? null,
    reasoning: hints.reasoning ?? entry?.capabilities.includes("reasoning") ?? null,
    source: hinted ? "endpoint" : entry ? "catalog" : null,
  };
}
