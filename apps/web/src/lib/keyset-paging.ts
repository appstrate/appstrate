// SPDX-License-Identifier: Apache-2.0

/**
 * The paging half of a keyset-paged `useInfiniteQuery`: the next page starts
 * after the last id seen (`startingAfter`), and a page without `hasMore` ends
 * the list. Spread into the query options; the caller keeps its key and fetch.
 */
export const keysetPaging = {
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last: { hasMore: boolean; data: readonly { id: string }[] }) =>
    last.hasMore ? last.data[last.data.length - 1]?.id : undefined,
};
