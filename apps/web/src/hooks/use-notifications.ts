// SPDX-License-Identifier: Apache-2.0

import { useQueryClient, type InvalidateOptions } from "@tanstack/react-query";
import { $api } from "../api/client";
import { useCurrentSpaceId } from "./use-current-space";
import { useOrgScope } from "./use-org-scope";
import { paginatedRunsKeys, runKeys } from "../lib/query-keys";
import type { operations } from "../api/schema";

/**
 * A notification kind (`?type=`). Runs are `run_completed`: the run screens
 * count them; the bell reads the other kinds, never runs.
 */
export type NotificationType = NonNullable<
  NonNullable<operations["listNotifications"]["parameters"]["query"]>["type"]
>;

/** The kind the bell shows — everything but runs, which the runs page lists. */
export const BELL_NOTIFICATION_TYPE = "package_shared" satisfies NotificationType;

/**
 * Safety-net poll, a BACKSTOP: freshness comes from `use-global-run-sync`, which invalidates
 * these caches on every terminal run and on every reconnect (SSE has no replay). Do NOT raise
 * this without keeping the reconnect-side invalidation, or a badge would take five minutes to correct.
 */
const NOTIFICATION_POLL_INTERVAL_MS = 300_000;

/** Unread notifications of one kind: `run_completed` for the run badges, the bell's own otherwise. */
export function useUnreadCount(type: NotificationType) {
  const scope = useOrgScope();
  // Badge counters only need a space context.
  const spaceId = useCurrentSpaceId();
  return $api.useQuery(
    "get",
    "/api/notifications/unread-count",
    { params: { header: scope.header, query: { type } } },
    {
      refetchInterval: NOTIFICATION_POLL_INTERVAL_MS,
      enabled: !!spaceId,
      select: (d) => d.count,
    },
  );
}

/** Recipient's notifications of one kind (newest first). `unread` filters to unread only. */
export function useNotifications(opts: {
  type: NotificationType;
  unread?: boolean;
  limit?: number;
}) {
  const scope = useOrgScope();
  const spaceId = useCurrentSpaceId();
  const { type, unread = true, limit = 50 } = opts;
  return $api.useQuery(
    "get",
    "/api/notifications",
    { params: { header: scope.header, query: { type, unread, limit } } },
    {
      refetchInterval: NOTIFICATION_POLL_INTERVAL_MS,
      enabled: !!spaceId,
      select: (d) => d.data,
    },
  );
}

export function useUnreadCountsByAgent() {
  const scope = useOrgScope();
  // Badge counters only need a space context.
  const spaceId = useCurrentSpaceId();
  return $api.useQuery(
    "get",
    "/api/notifications/unread-counts-by-agent",
    { params: { header: scope.header } },
    {
      refetchInterval: NOTIFICATION_POLL_INTERVAL_MS,
      enabled: !!spaceId,
      select: (d) => d.counts,
    },
  );
}

/** Notification list + badge counters — no run-list invalidation. */
export function invalidateNotificationQueries(
  qc: ReturnType<typeof useQueryClient>,
  options?: InvalidateOptions,
) {
  qc.invalidateQueries({ queryKey: ["get", "/api/notifications"] }, options);
  qc.invalidateQueries({ queryKey: ["get", "/api/notifications/unread-count"] }, options);
  qc.invalidateQueries({ queryKey: ["get", "/api/notifications/unread-counts-by-agent"] }, options);
}

function invalidateRunAndNotificationQueries(qc: ReturnType<typeof useQueryClient>) {
  invalidateNotificationQueries(qc);
  // Legacy keys — the run hooks are not migrated to the typed client yet.
  qc.invalidateQueries({ queryKey: paginatedRunsKeys.all });
  qc.invalidateQueries({ queryKey: runKeys.all });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return $api.useMutation("put", "/api/notifications/{id}/read", {
    meta: { errorHandledByCaller: true },
    onSuccess: () => invalidateRunAndNotificationQueries(qc),
  });
}

/** Mark the caller's notification for a run read, by run id (the run-detail page has no notification id). */
export function useMarkReadByRun() {
  const qc = useQueryClient();
  return $api.useMutation("put", "/api/notifications/read/{runId}", {
    // Background writes: nothing for the user to act on.
    meta: { errorHandledByCaller: true },
    onSuccess: () => invalidateRunAndNotificationQueries(qc),
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return $api.useMutation("put", "/api/notifications/read-all", {
    onSuccess: () => invalidateRunAndNotificationQueries(qc),
  });
}
