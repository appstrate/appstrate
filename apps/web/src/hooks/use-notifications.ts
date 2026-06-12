// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { $api } from "../api/client";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";

/**
 * Org/app context for queries. The headers are spec-declared params passed
 * explicitly (instead of relying on the client middleware alone) so they are
 * part of the React Query key — switching org or application refetches
 * instead of serving another scope's cached counters.
 */
function useOrgScope() {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return {
    // Badge counters only need an application context (legacy behavior).
    enabled: !!applicationId,
    header: {
      "X-Org-Id": orgId ?? undefined,
      "X-Application-Id": applicationId ?? undefined,
    },
  };
}

export function useUnreadCount() {
  const scope = useOrgScope();
  return $api.useQuery(
    "get",
    "/api/notifications/unread-count",
    { params: { header: scope.header } },
    {
      refetchInterval: 30_000,
      enabled: scope.enabled,
      select: (d) => d.count,
    },
  );
}

export function useUnreadCountsByAgent() {
  const scope = useOrgScope();
  return $api.useQuery(
    "get",
    "/api/notifications/unread-counts-by-agent",
    { params: { header: scope.header } },
    {
      refetchInterval: 30_000,
      enabled: scope.enabled,
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
  qc.invalidateQueries({ queryKey: ["paginated-runs"] });
  qc.invalidateQueries({ queryKey: ["runs"] });
  qc.invalidateQueries({ queryKey: ["run"] });
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
