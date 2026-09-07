// SPDX-License-Identifier: Apache-2.0

/**
 * Does a saved model row answer for its own limits and modalities, or is it
 * still following the catalog?
 *
 * `GET /api/models` returns RESOLVED values: a catalogued id reports the
 * catalog's own numbers whether or not the row overrides anything. Reading
 * "carries a value" as "overrides" would open the capabilities toggle on every
 * catalogued row, and saving it would freeze those numbers as overrides — so
 * renaming a row would quietly stop the weekly catalog refresh from reaching
 * it. The answer is a comparison against the registry entry, not a null check.
 *
 * `label` is deliberately out: the operator names the row, the catalog names
 * the model, and the two are allowed to differ without that meaning anything
 * about its capabilities.
 */

import { catalogModalities } from "./model-source";

/** The stored row's four catalog-derivable fields — an `OrgModel` fits. */
export interface StoredModelValues {
  input?: string[] | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  reasoning?: boolean | null;
}

/** The registry entry that would answer for them — a catalog model fits. */
export interface CatalogModelValues {
  contextWindow: number;
  maxTokens?: number | null;
  capabilities: string[];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v) => b.includes(v));
}

export function rowOverridesCatalog(
  row: StoredModelValues,
  entry: CatalogModelValues | undefined,
): boolean {
  // No entry to follow: whatever the row carries can only be its own answer.
  if (!entry) {
    return (
      !!row.input?.length ||
      row.contextWindow != null ||
      row.maxTokens != null ||
      row.reasoning != null
    );
  }
  if (row.contextWindow != null && row.contextWindow !== entry.contextWindow) return true;
  if (row.maxTokens != null && row.maxTokens !== (entry.maxTokens ?? null)) return true;
  if (row.reasoning != null && row.reasoning !== entry.capabilities.includes("reasoning")) {
    return true;
  }
  return !!row.input?.length && !sameSet(row.input, catalogModalities(entry.capabilities));
}
