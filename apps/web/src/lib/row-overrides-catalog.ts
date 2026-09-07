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

/** Two modality lists describing the same thing — order is not part of it. */
export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v) => b.includes(v));
}

/**
 * The four answers the catalog entry gives on its own, in the stored row's
 * shape. Both readers of this file compare against it: the toggle asks whether
 * the row already disagrees, the payload asks — field by field — whether what
 * is on screen is anything but the catalog's own number read back.
 */
export function catalogValues(entry: CatalogModelValues): {
  input: string[];
  contextWindow: number;
  maxTokens: number | null;
  reasoning: boolean;
} {
  return {
    input: catalogModalities(entry.capabilities),
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens ?? null,
    reasoning: entry.capabilities.includes("reasoning"),
  };
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
  const catalog = catalogValues(entry);
  if (row.contextWindow != null && row.contextWindow !== catalog.contextWindow) return true;
  if (row.maxTokens != null && row.maxTokens !== catalog.maxTokens) return true;
  if (row.reasoning != null && row.reasoning !== catalog.reasoning) return true;
  return !!row.input?.length && !sameSet(row.input, catalog.input);
}
