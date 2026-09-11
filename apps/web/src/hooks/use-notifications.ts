// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { $api } from "../api/client";
import { useCurrentSpaceId } from "./use-current-space";
import { useOrgScope } from "./use-org-scope";
import { paginatedRunsKeys, runsKeys, runKeys } from "../lib/query-keys";

/**
 * Safety-net poll for the notification queries — a BACKSTOP, not the freshness
 * mechanism.
 *
 * Freshness comes from the realtime stream: `use-global-run-sync` invalidates
 * these caches on every terminal run it sees, and re-invalidates them on every
 * (re)connect, which is what covers the frames lost while the stream was down
 * (the SSE protocol has no replay). With both of those in place the poll only
 * has to cover a client that is somehow neither streaming nor reconnecting, so
 * it runs at 5 minutes instead of 30 seconds — 10× fewer requests per open tab,
 * across three queries.
 *
 * Do NOT raise this without keeping the reconnect-side invalidation: on its own
 * the interval is the ONLY thing that would eventually correct a badge, and
 * "eventually" would become five minutes.
 */
const NOTIFICATION_POLL_INTERVAL_MS = 300_000;

export function useUnreadCount() {
  const scope = useOrgScope();
  // Badge counters only need a space context (legacy behavior).
  const spaceId = useCurrentSpaceId();
  return $api.useQuery(
    "get",
    "/api/notifications/unread-count",
    { params: { header: scope.header } },
    {
      refetchInterval: NOTIFICATION_POLL_INTERVAL_MS,
      enabled: !!spaceId,
      select: (d) => d.count,
    },
  );
}

/** Recipient's notifications (newest first). `unread` filters to unread only. */
export function useNotifications(opts: { unread?: boolean; limit?: number } = {}) {
  const scope = useOrgScope();
  const spaceId = useCurrentSpaceId();
  const { unread = true, limit = 50 } = opts;
  return $api.useQuery(
    "get",
    "/api/notifications",
    { params: { header: scope.header, query: { unread, limit } } },
    {
      refetchInterval: NOTIFICATION_POLL_INTERVAL_MS,
      enabled: !!spaceId,
      select: (d) => d.data,
    },
  );
}

export function useUnreadCountsByAgent() {
  const scope = useOrgScope();
  // Badge counters only need a space context (legacy behavior).
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
export function invalidateNotificationQueries(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["get", "/api/notifications"] });
  qc.invalidateQueries({ queryKey: ["get", "/api/notifications/unread-count"] });
  qc.invalidateQueries({ queryKey: ["get", "/api/notifications/unread-counts-by-agent"] });
}

function invalidateRunAndNotificationQueries(qc: ReturnType<typeof useQueryClient>) {
  invalidateNotificationQueries(qc);
  // Legacy keys — the run hooks are not migrated to the typed client yet.
  qc.invalidateQueries({ queryKey: paginatedRunsKeys.all });
  qc.invalidateQueries({ queryKey: runsKeys.all });
  qc.invalidateQueries({ queryKey: runKeys.all });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return $api.useMutation("put", "/api/notifications/{id}/read", {
    onSuccess: () => invalidateRunAndNotificationQueries(qc),
  });
}

/**
 * Mark the caller's notification for a run read, keyed by run id — used by the
 * run-detail page, which holds the run id but not the notification id.
 * Backed by `PUT /api/notifications/read/{runId}`.
 */
export function useMarkReadByRun() {
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
