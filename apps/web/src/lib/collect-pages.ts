// SPDX-License-Identifier: Apache-2.0

/** Every item of an offset-paginated list, following `hasMore` page by page. */
export async function collectAllPages<T>(
  fetchPage: (offset: number) => Promise<{ data: T[]; hasMore: boolean }>,
): Promise<T[]> {
  const items: T[] = [];
  for (;;) {
    const page = await fetchPage(items.length);
    items.push(...page.data);
    if (!page.hasMore || page.data.length === 0) return items;
  }
}
