// SPDX-License-Identifier: Apache-2.0

/**
 * What we know about a model id an endpoint serves: the listing's own hints
 * win field by field, the vendored catalog fills the rest (`label` is
 * catalog-only). Catalog lookup: the provider's own, then any by exact id,
 * then any by the id with one leading `<vendor>/` stripped. Cost is never
 * returned: an endpoint serving a vendor's id is not billed at the vendor's
 * rate, and a wrong price would corrupt `llm_usage`.
 */

import type { CatalogModelEntry } from "@appstrate/shared-types";
import { INPUT_MODALITIES, type ServedModelHints } from "./model-listing.ts";
import { listCatalogProviderIds, lookupCatalogModel } from "../pricing-catalog.ts";
import { getModelProvider } from "./registry.ts";

const MODALITIES: readonly string[] = INPUT_MODALITIES;

/** Everything we can tell about a served id, minus its price. */
interface ServedModelDescription {
  label: string | null;
  contextWindow: number | null;
  maxTokens: number | null;
  /** Accepted input modalities — the `text`/`image` subset of the capabilities. */
  input: string[] | null;
  reasoning: boolean | null;
  /** `endpoint` when the listing published any field, `catalog` on a pure hit, else `null`. */
  source: "endpoint" | "catalog" | null;
  /** Only these fields may be persisted as endpoint capability overrides. */
  endpointCapabilities: ServedModelHints;
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
    input: hints.input ?? entry?.capabilities.filter((c) => MODALITIES.includes(c)) ?? null,
    reasoning: hints.reasoning ?? entry?.capabilities.includes("reasoning") ?? null,
    source: hinted ? "endpoint" : entry ? "catalog" : null,
    endpointCapabilities: hints,
  };
}
