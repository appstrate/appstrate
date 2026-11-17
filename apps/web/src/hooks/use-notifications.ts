// SPDX-License-Identifier: Apache-2.0

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InvalidateOptions,
} from "@tanstack/react-query";
import { $api, client } from "../api/client";
import { keysetPaging, pagedQueryKey } from "@appstrate/ui/keyset-paging";
import { useCurrentSpaceId } from "./use-current-space";
import { useListScope, useOrgScope } from "./use-org-scope";

/**
 * The notification feed — the dashboard bell: a failed run, a share. A run's
 * read state rides with the runs (`use-run-reads.ts`).
 *
 * A finished run of the working space re-reads the feed from the realtime
 * stream (`use-global-run-sync`, on every terminal frame and every reconnect);
 * nothing announces a share, so the poll is what brings one in. `spanning`
 * (« Tous les espaces ») reads every space the caller holds a role in from the
 * org routes; the stream carries the working space only, so it polls at the
 * pace of the other lists spanning spaces.
 */
const NOTIFICATION_POLL_INTERVAL_MS = 300_000;

/** The feed's scope: the working space's, or every reached space's. */
function useFeedScope(spanning: boolean) {
  const { header } = useOrgScope();
  // The feed asks no role grant: being in the space is the whole rule.
  const scope = useListScope(spanning, true);
  return {
    header,
    acrossOrgId: scope.acrossOrgId,
    orgId: scope.orgId ?? "",
    enabled: scope.enabled,
    refetchInterval: scope.refetchInterval ?? NOTIFICATION_POLL_INTERVAL_MS,
  };
}

export function useUnreadCount({ spanning = false } = {}) {
  const scope = useFeedScope(spanning);
  const options = {
    refetchInterval: scope.refetchInterval,
    enabled: scope.enabled,
    select: (d: { count: number }) => d.count,
  };
  const inSpace = $api.useQuery(
    "get",
    "/api/notifications/unread-count",
    { params: { header: scope.header } },
    { ...options, enabled: !spanning && options.enabled },
  );
  const across = $api.useQuery(
    "get",
    "/api/orgs/{orgId}/notifications/unread-count",
    { params: { path: { orgId: scope.orgId } } },
    { ...options, enabled: spanning && options.enabled },
  );
  return spanning ? across : inSpace;
}

/**
 * Recipient's notifications (newest first), keyset-paged. `unread` filters to unread only;
 * `spanning` lists every reached space's, each row carrying its `spaceId`. `enabled: false`
 * reads nothing (the bell's list while it is closed: its badge is the count's).
 */
export function useNotifications(
  opts: { unread?: boolean; limit?: number; spanning?: boolean; enabled?: boolean } = {},
) {
  const { unread = true, limit = 50, spanning = false, enabled = true } = opts;
  const scope = useFeedScope(spanning);
  const query = { unread, limit };
  return useInfiniteQuery({
    queryKey: spanning
      ? pagedQueryKey("/api/orgs/{orgId}/notifications", {
          params: { path: { orgId: scope.orgId }, query },
        })
      : pagedQueryKey("/api/notifications", { params: { header: scope.header, query } }),
    queryFn: async ({ pageParam, signal }) => {
      const paged = { ...query, startingAfter: pageParam };
      const { data } = scope.acrossOrgId
        ? await client.GET("/api/orgs/{orgId}/notifications", {
            params: { path: { orgId: scope.acrossOrgId }, query: paged },
            signal,
          })
        : await client.GET("/api/notifications", {
            params: { header: scope.header, query: paged },
            signal,
          });
      if (!data) throw new Error("empty response");
      return data;
    },
    ...keysetPaging,
    refetchInterval: scope.refetchInterval,
    enabled: enabled && scope.enabled,
    select: (d) => d.pages.flatMap((page) => page.data),
  });
}

/** The feed and its badge, of one space and across spaces. */
export function invalidateNotificationQueries(
  qc: ReturnType<typeof useQueryClient>,
  options?: InvalidateOptions,
) {
  for (const path of [
    "/api/notifications",
    "/api/notifications/unread-count",
    "/api/orgs/{orgId}/notifications",
    "/api/orgs/{orgId}/notifications/unread-count",
  ]) {
    qc.invalidateQueries({ queryKey: ["get", path] }, options);
  }
}

/** One notification of the caller — the notification's page. */
export function useNotification(id: string | undefined) {
  const scope = useOrgScope();
  const spaceId = useCurrentSpaceId();
  return $api.useQuery(
    "get",
    "/api/notifications/{id}",
    { params: { header: scope.header, path: { id: id ?? "" } } },
    { enabled: !!spaceId && !!id },
  );
}

export function useMarkRead() {
  const qc = useQueryClient();
  return $api.useMutation("put", "/api/notifications/{id}/read", {
    meta: { errorHandledByCaller: true },
    onSuccess: () => invalidateNotificationQueries(qc),
  });
}

/**
 * « Tout marquer comme lu »: the working space's feed (`null`), or each listed space's — the
 * route reads one space, so one request per space, each naming it. Every request settles before
 * the outcome: one refusal fails the mutation once, with the first refusal, after the others
 * have landed; the feed is refreshed either way.
 */
export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (spaceIds: readonly string[] | null) => markAllReadIn(spaceIds, markReadInSpace),
    onSettled: () => invalidateNotificationQueries(qc),
  });
}

function markReadInSpace(spaceId: string | null): Promise<unknown> {
  return client.PUT("/api/notifications/read-all", {
    params: spaceId ? { header: { "X-Space-Id": spaceId } } : {},
  });
}

/** {@link useMarkAllRead}'s requests, `put` sending one. Exported for its test. */
export async function markAllReadIn(
  spaceIds: readonly string[] | null,
  put: (spaceId: string | null) => Promise<unknown>,
): Promise<void> {
  const outcomes = await Promise.allSettled((spaceIds ?? [null]).map(put));
  const refused = outcomes.find((outcome) => outcome.status === "rejected");
  if (refused) throw refused.reason;
}
