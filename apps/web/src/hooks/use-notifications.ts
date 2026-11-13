// SPDX-License-Identifier: Apache-2.0

import { useQueryClient, type InvalidateOptions } from "@tanstack/react-query";
import { $api } from "../api/client";
import { useCurrentSpaceId } from "./use-current-space";
import { useOrgScope } from "./use-org-scope";

/**
 * The notification feed — the dashboard bell: a failed run, a share. A run's
 * read state rides with the runs (`use-run-reads.ts`).
 *
 * A finished run re-reads the feed from the realtime stream
 * (`use-global-run-sync`, on every terminal frame and every reconnect); nothing
 * announces a share, so the poll is what brings one in.
 */
const NOTIFICATION_POLL_INTERVAL_MS = 300_000;

export function useUnreadCount() {
  const scope = useOrgScope();
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

/** The feed and its badge. */
export function invalidateNotificationQueries(
  qc: ReturnType<typeof useQueryClient>,
  options?: InvalidateOptions,
) {
  qc.invalidateQueries({ queryKey: ["get", "/api/notifications"] }, options);
  qc.invalidateQueries({ queryKey: ["get", "/api/notifications/unread-count"] }, options);
}

export function useMarkRead() {
  const qc = useQueryClient();
  return $api.useMutation("put", "/api/notifications/{id}/read", {
    meta: { errorHandledByCaller: true },
    onSuccess: () => invalidateNotificationQueries(qc),
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return $api.useMutation("put", "/api/notifications/read-all", {
    onSuccess: () => invalidateNotificationQueries(qc),
  });
}
