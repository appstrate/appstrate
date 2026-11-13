// SPDX-License-Identifier: Apache-2.0

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { $api } from "../api/client";
import { usePaginatedRuns } from "./use-paginated-runs";
import { agentsKeys, paginatedRunsKeys, runKeys, scheduleKeys } from "../lib/query-keys";
import { invalidateNotificationQueries } from "./use-notifications";

/**
 * Run read state, per recipient: `unread` on a run, `unread_count` on an agent
 * and on a schedule, and the caller's total below. The run SSE stream keeps
 * them fresh (a finished run refreshes those caches); a write here refreshes
 * them at once. Reading a run also reads its notification, when the bell held
 * one, so the feed is refreshed with them.
 */

/** The caller's unread runs in the space — the Runs badge. */
export function useUnreadRunCount(): number {
  const { data } = usePaginatedRuns({ unread: true, limit: 1, offset: 0 });
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

export function useMarkAllRunsRead() {
  const qc = useQueryClient();
  return $api.useMutation("put", "/api/runs/read-all", {
    onSuccess: () => invalidateRunReadState(qc),
  });
}
