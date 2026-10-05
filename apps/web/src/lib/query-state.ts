// SPDX-License-Identifier: Apache-2.0

import type { FetchStatus } from "@tanstack/react-query";

/**
 * Pending and not idle. Not `isLoading`: React Query pauses a retry in a
 * background tab, and a paused query is not fetching.
 */
export function isQueryInFlight(query: { isPending: boolean; fetchStatus: FetchStatus }): boolean {
  return query.isPending && query.fetchStatus !== "idle";
}
