// SPDX-License-Identifier: Apache-2.0

/** The keyword search `search_operations` and `search_integration_tools` share. */

export const DEFAULT_SEARCH_LIMIT = 25;
export const MAX_SEARCH_LIMIT = 100;

/** The lowercase keywords of a `query` argument; none when it is absent or blank. */
export function searchTokens(query: unknown): string[] {
  return typeof query === "string" ? query.trim().toLowerCase().split(/\s+/).filter(Boolean) : [];
}

/** A `limit` argument, held to 1…{@link MAX_SEARCH_LIMIT}. */
export function searchLimit(raw: unknown): number {
  const limit = typeof raw === "number" ? raw : DEFAULT_SEARCH_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_SEARCH_LIMIT);
}

/** How many keywords `text` contains, case-insensitively. */
export function searchScore(text: string, tokens: readonly string[]): number {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const token of tokens) if (haystack.includes(token)) score += 1;
  return score;
}
