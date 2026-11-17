// SPDX-License-Identifier: Apache-2.0

import { useInfiniteQuery } from "@tanstack/react-query";
import { canReadRuns } from "@appstrate/core/permissions";
import { client } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useListScope } from "./use-org-scope";
import { usePermissions } from "./use-permissions";
import { paginatedRunsKeys } from "../lib/query-keys";
import { keysetPaging } from "@appstrate/ui/keyset-paging";
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
  /** Every space the reader reaches instead of the current one (`GET /api/orgs/{orgId}/runs`) — the global view only. */
  spanning?: boolean;
  /** `false` keeps the query from asking (a badge the shell does not show). */
  enabled?: boolean;
  limit?: number;
}

/** One page of runs everywhere (runs page, agent tab, schedule tab). */
const RUNS_PAGE_SIZE = 25;

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
  spanning,
  enabled = true,
  limit = RUNS_PAGE_SIZE,
}: UseRunsOptions) {
  const { can } = usePermissions();
  // Every door guards on `requireRunsRead`; a schedule's runs also on `schedules:read`.
  const canRead = canReadRuns(can) && (!scheduleId || can("schedules:read"));
  // The org route serves the global view only; inside an agent or a schedule the space is theirs.
  const acrossSpaces = !scheduleId && !packageId && !!spanning;
  const scope = useListScope(acrossSpaces, canRead);
  const { orgId, keySpace } = scope;

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
    keySpace,
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
    queryFn: ({ pageParam, signal }) =>
      fetchRunPage(
        {
          packageId,
          scheduleId,
          user,
          kind,
          status: statusQuery,
          search,
          unread,
          acrossOrgId: scope.acrossOrgId,
          limit,
          startingAfter: pageParam,
        },
        signal,
      ),
    ...keysetPaging,
    placeholderData: (prev, prevQuery) =>
      prevQuery && keepsRunRows(prevQuery.queryKey, currentKey) ? prev : undefined,
    enabled: enabled && scope.enabled,
    refetchInterval: scope.refetchInterval,
  });
}

/** Only the first page (a count, the latest run); the same cache entry as the list of the same shape. */
export function useFirstRunsPage(options: UseRunsOptions) {
  const query = useRuns(options);
  return { ...query, data: query.data?.pages[0] };
}

/** One page's question: the hook's filters, the cursor, and the org when it spans its spaces. */
type RunPageRequest = Omit<UseRunsOptions, "spanning" | "enabled"> & {
  limit: number;
  startingAfter?: string;
  acrossOrgId: string | null;
};

/**
 * One page, from the door the request names. `user`/`kind`/`unread` exist only on the global
 * view; `acrossOrgId` moves it to the org route. Exported for its test.
 */
export async function fetchRunPage(
  {
    packageId,
    scheduleId,
    user,
    kind,
    status,
    search,
    unread,
    acrossOrgId,
    limit,
    startingAfter,
  }: RunPageRequest,
  signal?: AbortSignal,
): Promise<RunsPage> {
  const q = search || undefined;
  if (scheduleId) {
    const { data } = await client.GET("/api/schedules/{id}/runs", {
      params: { path: { id: scheduleId }, query: { limit, startingAfter, status, q } },
      signal,
    });
    return data!;
  }
  if (packageId) {
    const { scope, name } = splitPackageRef(packageId);
    const { data } = await client.GET("/api/agents/{scope}/{name}/runs", {
      params: { path: { scope, name }, query: { limit, startingAfter, status, q } },
      signal,
    });
    return data!;
  }
  const query = {
    limit,
    startingAfter,
    user,
    kind: kind && kind !== "all" ? kind : undefined,
    status,
    q,
    unread: unread || undefined,
  };
  if (acrossOrgId) {
    const { data } = await client.GET("/api/orgs/{orgId}/runs", {
      params: { path: { orgId: acrossOrgId }, query },
      signal,
    });
    return data!;
  }
  const { data } = await client.GET("/api/runs", { params: { query }, signal });
  return data!;
}
