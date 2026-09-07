// SPDX-License-Identifier: Apache-2.0

/**
 * Does a saved model row answer for its own limits and modalities, or is it
 * still following the catalog? `GET /api/models` returns RESOLVED values, so
 * "carries a value" is not "overrides": the answer is a comparison against the
 * registry entry. `label` is deliberately out of it.
 */

const MODALITIES = ["text", "image"];

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

export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v) => b.includes(v));
}

/** The catalog entry's four answers, in the stored row's shape. */
export function catalogValues(entry: CatalogModelValues): {
  input: string[];
  contextWindow: number;
  maxTokens: number | null;
  reasoning: boolean;
} {
  return {
    input: entry.capabilities.filter((c) => MODALITIES.includes(c)),
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens ?? null,
    reasoning: entry.capabilities.includes("reasoning"),
  };
}

export function rowOverridesCatalog(
  row: StoredModelValues,
  entry: CatalogModelValues | undefined,
): boolean {
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
