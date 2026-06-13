// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { $api } from "../api/client";
import { useCurrentApplicationId } from "./use-current-application";
import { useOrgScope } from "./use-org-scope";
import { paginatedRunsKeys, runsKeys, runKeys } from "../lib/query-keys";

export function useUnreadCount() {
  const scope = useOrgScope();
  // Badge counters only need an application context (legacy behavior).
  const applicationId = useCurrentApplicationId();
  return $api.useQuery(
    "get",
    "/api/notifications/unread-count",
    { params: { header: scope.header } },
    {
      refetchInterval: 30_000,
      enabled: !!applicationId,
      select: (d) => d.count,
    },
  );
}

export function useUnreadCountsByAgent() {
  const scope = useOrgScope();
  // Badge counters only need an application context (legacy behavior).
  const applicationId = useCurrentApplicationId();
  return $api.useQuery(
    "get",
    "/api/notifications/unread-counts-by-agent",
    { params: { header: scope.header } },
    {
      refetchInterval: 30_000,
      enabled: !!applicationId,
      select: (d) => d.counts,
    },
  );
}

/** Notification badge counters only — no run-list invalidation. */
export function invalidateNotificationQueries(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["get", "/api/notifications/unread-count"] });
  qc.invalidateQueries({ queryKey: ["get", "/api/notifications/unread-counts-by-agent"] });
}

export function invalidateRunAndNotificationQueries(qc: ReturnType<typeof useQueryClient>) {
  invalidateNotificationQueries(qc);
  // Legacy keys — the run hooks are not migrated to the typed client yet.
  qc.invalidateQueries({ queryKey: paginatedRunsKeys.all });
  qc.invalidateQueries({ queryKey: runsKeys.all });
  qc.invalidateQueries({ queryKey: runKeys.all });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return $api.useMutation("put", "/api/notifications/read/{runId}", {
    onSuccess: () => invalidateRunAndNotificationQueries(qc),
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return $api.useMutation("put", "/api/notifications/read-all", {
    onSuccess: () => invalidateRunAndNotificationQueries(qc),
  });
}
