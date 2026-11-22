// SPDX-License-Identifier: Apache-2.0

import { useInfiniteQuery } from "@tanstack/react-query";
import { canReadRuns } from "@appstrate/core/permissions";
import { client } from "../api/client";
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
  /** Several travel as one comma-separated value; the route refuses a value outside the enum. */
  status?: RunStatus[];
  /** Free text matched against the agent, the error and the run number. */
  search?: string;
  /** The caller's unread runs only (the runs page). */
  unread?: boolean;
  /** Every space the reader reaches (`GET /api/orgs/{orgId}/runs`); ignored for a schedule's list. */
  spanning?: boolean;
  /** Narrows an org-wide list to these spaces (`spaceId`); ignored off the org-wide route. */
  spaceIds?: readonly string[];
  enabled?: boolean;
  limit?: number;
}

const RUNS_PAGE_SIZE = 25;

/** One page of runs, newest first. */
export type RunsPage = ListEnvelope<EnrichedRun> & { total: number };

/**
 * Whether the previous rows stay on screen while `currentKey` loads: when only the search
 * (the key's second-to-last segment, `paginatedRunsKeys.list`) changed.
 */
export function keepsRunRows(previousKey: readonly unknown[], currentKey: readonly unknown[]) {
  const filters = (key: readonly unknown[]) => [...key.slice(0, -2), key[key.length - 1]];
  const current = filters(currentKey);
  const previous = filters(previousKey);
  return (
    previous.length === current.length && previous.every((segment, i) => segment === current[i])
  );
}

/** The runs list, paged with `fetchNextPage`. */
export function useRuns({
  packageId,
  scheduleId,
  user,
  kind,
  status,
  search,
  unread,
  spanning,
  spaceIds,
  enabled = true,
  limit = RUNS_PAGE_SIZE,
}: UseRunsOptions) {
  const { can } = usePermissions();
  const canRead = canReadRuns(can) && (!scheduleId || can("schedules:read"));
  const acrossSpaces = !scheduleId && !!spanning;
  const scope = useListScope(acrossSpaces, canRead);
  const { orgId, keySpace } = scope;

  const statusKey = status && status.length > 0 ? status.join(",") : undefined;
  const statusQuery = status && status.length > 0 ? status : undefined;

  const endpoint = scheduleId
    ? `/schedules/${scheduleId}/runs`
    : packageId
      ? `/agents/${packageId}/runs`
      : `/runs`;

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
    // The key carries them only where the request does.
    acrossSpaces ? spaceIds : undefined,
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
          spaceIds,
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

/** The first page only; the same cache entry as the list of the same options. */
export function useFirstRunsPage(options: UseRunsOptions) {
  const query = useRuns(options);
  return { ...query, data: query.data?.pages[0] };
}

/** An agent's latest run in every space the reader reaches. */
export function useAgentLatestRunAcross(packageId: string, { enabled }: { enabled: boolean }) {
  return useFirstRunsPage({ packageId, spanning: true, limit: 1, enabled });
}

const IN_FLIGHT_PAGE = 25;
const IN_FLIGHT: RunStatus[] = ["pending", "running"];

/**
 * An agent's runs in flight (`pending`, `running`) in every space the reader reaches, and their
 * `total`. `busyIn(spaceId)`: a run of that space is on the first page, or the page is loading.
 * Past the first page the delete route refuses, atomically, what this offers.
 */
export function useAgentRunsInFlightAcross(packageId: string, { enabled }: { enabled: boolean }) {
  const query = useFirstRunsPage({
    packageId,
    spanning: true,
    status: IN_FLIGHT,
    limit: IN_FLIGHT_PAGE,
    enabled,
  });
  const page = query.data;
  return {
    ...query,
    total: page?.total,
    busyIn: (spaceId: string) => !page || page.data.some((run) => run.spaceId === spaceId),
  };
}

/** One page's request: the filters, the cursor, and the org when it spans its spaces. */
type RunPageRequest = Omit<UseRunsOptions, "spanning" | "enabled"> & {
  limit: number;
  startingAfter?: string;
  acrossOrgId: string | null;
};

/** One page: a schedule's runs, else the current space's runs, or the org's with `acrossOrgId`. Exported for its test. */
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
    spaceIds,
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
  const query = {
    limit,
    startingAfter,
    packageId,
    user,
    kind: kind && kind !== "all" ? kind : undefined,
    status,
    q,
    unread: unread || undefined,
  };
  if (acrossOrgId) {
    const { data } = await client.GET("/api/orgs/{orgId}/runs", {
      params: {
        path: { orgId: acrossOrgId },
        // An array: the client serializes it comma-separated (`QUERY_SERIALIZER`).
        query: { ...query, spaceId: spaceIds?.length ? [...spaceIds] : undefined },
      },
      signal,
    });
    return data!;
  }
  const { data } = await client.GET("/api/runs", { params: { query }, signal });
  return data!;
}
