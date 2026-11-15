// SPDX-License-Identifier: Apache-2.0

import { useInfiniteQuery } from "@tanstack/react-query";
import { canReadRuns } from "@appstrate/core/permissions";
import { client } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useCurrentOrgId } from "./use-org";
import { useCurrentSpaceId } from "./use-current-space";
import { usePermissions } from "./use-permissions";
import { paginatedRunsKeys } from "../lib/query-keys";
import { keysetPaging } from "../lib/keyset-paging";
import type { EnrichedRun, ListEnvelope } from "@appstrate/shared-types";
import type { RunStatus } from "@appstrate/core/run-status";

export type RunKindFilter = "all" | "package" | "inline";

interface UseRunsOptions {
  packageId?: string;
  scheduleId?: string;
  user?: "me";
  kind?: RunKindFilter;
  /** `RunStatus`, not `string`: `GET /api/runs` answers 400 on a value outside the enum. Several travel as one comma-separated value. */
  status?: RunStatus[];
  /** Free text, matched server-side against the agent, the error and the run number. */
  search?: string;
  /** Only the runs the caller has not read yet — the global `/api/runs` view only. */
  unread?: boolean;
  limit?: number;
}

/** One page of runs everywhere (runs page, agent tab, schedule tab). */
export const RUNS_PAGE_SIZE = 25;

/** What a runs query holds: the envelopes of the pages loaded so far, newest run first. */
export type RunsPage = ListEnvelope<EnrichedRun> & { total: number };

/**
 * Whether the previous rows stay on screen while a new key loads: yes while SEARCHING, no when a
 * filter changed. The key ends with `search, limit` (`paginatedRunsKeys.list`); the segments
 * before them are the filters.
 */
export function keepsRunRows(previousKey: readonly unknown[], currentKey: readonly unknown[]) {
  const filters = (key: readonly unknown[]) => [...key.slice(0, -2), key[key.length - 1]];
  const current = filters(currentKey);
  const previous = filters(previousKey);
  return (
    previous.length === current.length && previous.every((segment, i) => segment === current[i])
  );
}

/** The list: every page loaded so far, loaded on with `fetchNextPage`. */
export function useRuns({
  packageId,
  scheduleId,
  user,
  kind,
  status,
  search,
  unread,
  limit = RUNS_PAGE_SIZE,
}: UseRunsOptions) {
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const { can } = usePermissions();
  // Every door guards on `requireRunsRead`; a schedule's runs also on `schedules:read`.
  const canRead = canReadRuns(can) && (!scheduleId || can("schedules:read"));

  // One value in the key: an array keys on identity, so a fresh `["failed"]` each render is a new entry.
  const statusKey = status && status.length > 0 ? status.join(",") : undefined;
  const statusQuery = status && status.length > 0 ? status : undefined;

  const endpoint = scheduleId
    ? `/schedules/${scheduleId}/runs`
    : packageId
      ? `/agents/${packageId}/runs`
      : `/runs`;

  // use-global-run-sync and the run mutations invalidate by the key prefix.
  const currentKey = paginatedRunsKeys.list(
    orgId,
    spaceId,
    endpoint,
    user,
    kind,
    statusKey,
    unread,
    search,
    limit,
  );

  return useInfiniteQuery({
    queryKey: currentKey,
    // `user`/`kind`/`unread` exist only on the global /api/runs view.
    queryFn: async ({ pageParam, signal }): Promise<RunsPage> => {
      const q = search || undefined;
      if (scheduleId) {
        const { data } = await client.GET("/api/schedules/{id}/runs", {
          params: {
            path: { id: scheduleId },
            query: { limit, startingAfter: pageParam, status: statusQuery, q },
          },
          signal,
        });
        return data!;
      }
      if (packageId) {
        const { scope, name } = splitPackageRef(packageId);
        const { data } = await client.GET("/api/agents/{scope}/{name}/runs", {
          params: {
            path: { scope, name },
            query: { limit, startingAfter: pageParam, status: statusQuery, q },
          },
          signal,
        });
        return data!;
      }
      const { data } = await client.GET("/api/runs", {
        params: {
          query: {
            limit,
            startingAfter: pageParam,
            user,
            kind: kind && kind !== "all" ? kind : undefined,
            status: statusQuery,
            q,
            unread: unread || undefined,
          },
        },
        signal,
      });
      return data!;
    },
    ...keysetPaging,
    placeholderData: (prev, prevQuery) =>
      prevQuery && keepsRunRows(prevQuery.queryKey, currentKey) ? prev : undefined,
    enabled: canRead && !!spaceId,
  });
}

/** Only the first page (a count, the latest run); the same cache entry as the list of the same shape. */
export function useFirstRunsPage(options: UseRunsOptions) {
  const query = useRuns(options);
  return { ...query, data: query.data?.pages[0] };
}
