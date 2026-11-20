// SPDX-License-Identifier: Apache-2.0

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

export interface KeywordScore {
  exact: boolean;
  inName: number;
  inText: number;
  length: number;
}

function keywordScore(name: string, text: string, tokens: readonly string[]): KeywordScore {
  return {
    exact: tokens.length > 0 && name.toLowerCase() === tokens.join(" "),
    inName: searchScore(name, tokens),
    inText: searchScore(text, tokens),
    length: name.length,
  };
}

/** Negative when `a` ranks before `b`: exact name, then tokens in the name, then in the text, then the shorter name. */
export function compareKeywordScores(
  a: KeywordScore,
  b: KeywordScore,
  tokens: readonly string[],
): number {
  return (
    Number(b.exact) - Number(a.exact) ||
    b.inName - a.inName ||
    b.inText - a.inText ||
    (tokens.length > 0 ? a.length - b.length : 0)
  );
}

/** `items` matching `tokens` (all when there are none), best first, ties kept in the order given. */
export function rankByKeywords<T>(
  items: readonly T[],
  tokens: readonly string[],
  fields: (item: T) => { name: string; text: string },
): { item: T; score: KeywordScore }[] {
  return items
    .map((item, order) => {
      const { name, text } = fields(item);
      return { item, order, score: keywordScore(name, text, tokens) };
    })
    .filter(({ score }) => tokens.length === 0 || score.inName + score.inText > 0)
    .sort((a, b) => compareKeywordScores(a.score, b.score, tokens) || a.order - b.order)
    .map(({ item, score }) => ({ item, score }));
}
