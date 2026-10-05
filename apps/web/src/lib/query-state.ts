// SPDX-License-Identifier: Apache-2.0

import type { FetchStatus } from "@tanstack/react-query";

/**
 * Whether a query has neither data nor a verdict yet but is still on its way.
 *
 * Not `isLoading` (`isPending && isFetching`): React Query PAUSES a retry while
 * the tab is in the background, and a paused query is not fetching. A page that
 * reads "not loading, no data" as "nothing there" then redirects away from a
 * request still in flight — and from the error it was about to report. A
 * disabled query is `idle`, which is not in flight.
 */
export function isQueryInFlight(query: { isPending: boolean; fetchStatus: FetchStatus }): boolean {
  return query.isPending && query.fetchStatus !== "idle";
}
