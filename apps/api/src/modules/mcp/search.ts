// SPDX-License-Identifier: Apache-2.0

/** The keyword search `search_operations` and `search_integration_tools` share. */

export const DEFAULT_SEARCH_LIMIT = 25;
export const MAX_SEARCH_LIMIT = 100;

export function searchTokens(query: unknown): string[] {
  return typeof query === "string" ? query.trim().toLowerCase().split(/\s+/).filter(Boolean) : [];
}

export function searchLimit(raw: unknown): number {
  const limit = typeof raw === "number" ? raw : DEFAULT_SEARCH_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_SEARCH_LIMIT);
}

export function searchScore(text: string, tokens: readonly string[]): number {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const token of tokens) if (haystack.includes(token)) score += 1;
  return score;
}

/**
 * `items` matching `tokens` (all of them when there are none), best first: an item whose name is
 * the query itself, then by the tokens its name holds, then by those its text holds, then the
 * shorter name (the one the tokens cover most), ties kept in the order given.
 */
export function rankByKeywords<T>(
  items: readonly T[],
  tokens: readonly string[],
  fields: (item: T) => { name: string; text: string },
): T[] {
  const query = tokens.join(" ");
  return items
    .map((item, order) => {
      const { name, text } = fields(item);
      return {
        item,
        order,
        exact: tokens.length > 0 && name.toLowerCase() === query,
        inName: searchScore(name, tokens),
        inText: searchScore(text, tokens),
        length: name.length,
      };
    })
    .filter(({ inName, inText }) => tokens.length === 0 || inName + inText > 0)
    .sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        b.inName - a.inName ||
        b.inText - a.inText ||
        (tokens.length > 0 ? a.length - b.length : 0) ||
        a.order - b.order,
    )
    .map(({ item }) => item);
}
