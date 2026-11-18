// SPDX-License-Identifier: Apache-2.0

import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { $api, client } from "../api/client";
import { markAllRunsReadRequests } from "../lib/mark-all-runs-read";
import { useFirstRunsPage } from "./use-paginated-runs";
import { agentsKeys, paginatedRunsKeys, runKeys, scheduleKeys } from "../lib/query-keys";
import { invalidateNotificationQueries } from "./use-notifications";

/**
 * Run read state, per recipient: `unread` on a run, `unread_count` on an agent
 * and on a schedule, and the caller's total below. The run SSE stream keeps
 * them fresh (a finished run refreshes those caches); a write here refreshes
 * them at once. Reading a run also reads its notification, when the bell held
 * one, so the feed is refreshed with them.
 */

/**
 * The caller's unread runs in the space — the Runs badge; `enabled: false` where it is not shown.
 * `spanning`: in every space the reader reaches instead.
 */
export function useUnreadRunCount({ enabled = true, spanning = false } = {}): number {
  const { data } = useFirstRunsPage({ unread: true, limit: 1, enabled, spanning });
  return data?.total ?? 0;
}

function invalidateRunReadState(qc: QueryClient) {
  invalidateNotificationQueries(qc);
  for (const queryKey of [
    runKeys.all,
    paginatedRunsKeys.all,
    agentsKeys.all,
    scheduleKeys.listAll,
    scheduleKeys.detailAll,
    // The chat context sidebar reads this typed collection.
    ["get", "/api/runs"],
  ]) {
    void qc.invalidateQueries({ queryKey });
  }
}

/** Mark one run read — the run-detail page, on opening a finished run. */
export function useMarkRunRead() {
  const qc = useQueryClient();
  return $api.useMutation("put", "/api/runs/{id}/read", {
    // Background write: nothing for the user to act on.
    meta: { errorHandledByCaller: true },
    onSuccess: () => invalidateRunReadState(qc),
  });
}

/**
 * « Tout marquer comme lu »: the working space's runs (`null`), or every listed space's
 * (`markAllRunsReadRequests`). The read state is refreshed even when one space refused.
 */
export function useMarkAllRunsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (spaceIds: readonly string[] | null) =>
      Promise.all(
        markAllRunsReadRequests(spaceIds).map((inSpace) =>
          client.PUT("/api/runs/read-all", inSpace),
        ),
      ),
    onSettled: () => invalidateRunReadState(qc),
  });
}
