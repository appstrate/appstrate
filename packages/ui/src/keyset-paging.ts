// SPDX-License-Identifier: Apache-2.0

/**
 * The key of a keyset-paged `useInfiniteQuery`: `[method, path, "paged", init]`. The
 * `[method, path]` prefix lets write invalidations reach it like any generated key; the marker
 * keeps it apart from a plain `$api.useQuery` on the same path, whose cache holds a different shape.
 */
export function pagedQueryKey<const P extends string, const I>(path: P, init: I) {
  return ["get", path, "paged", init] as const;
}

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
