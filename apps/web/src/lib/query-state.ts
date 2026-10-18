// SPDX-License-Identifier: Apache-2.0

import type { FetchStatus } from "@tanstack/react-query";

/**
 * Pending and not idle. Not `isLoading`: React Query pauses a retry in a
 * background tab, and a paused query is not fetching.
 */
export function isQueryInFlight(query: { isPending: boolean; fetchStatus: FetchStatus }): boolean {
  return query.isPending && query.fetchStatus !== "idle";
}

/**
 * The package a generated `[method, path, init]` key reads (`init.params.path`
 * holds `{ scope, name }`), or `undefined` for any other key shape.
 */
export function generatedKeyPackage(key: readonly unknown[]): string | undefined {
  const init = key[2] as { params?: { path?: { scope?: string; name?: string } } } | undefined;
  const path = init?.params?.path;
  return path?.scope && path.name ? `${path.scope}/${path.name}` : undefined;
}

/** The package of a `versionKeys.detail` key (type and id, never the version). */
export function versionKeyPackage(key: readonly unknown[]): string | undefined {
  return key[0] === "version-detail" && key[3] !== undefined && key[4] !== undefined
    ? `${String(key[3])}/${String(key[4])}`
    : undefined;
}

/**
 * `placeholderData` that keeps the previous result only while it belongs to
 * `current`: a file tree, a file or a version may stand in for the next one of
 * the same package, never another package's.
 */
export function keepPreviousWithin(
  current: string | undefined,
  packageOf: (key: readonly unknown[]) => string | undefined,
) {
  return <T>(
    previous: T | undefined,
    previousQuery: { queryKey: readonly unknown[] } | undefined,
  ) =>
    current !== undefined && previousQuery && packageOf(previousQuery.queryKey) === current
      ? previous
      : undefined;
}
