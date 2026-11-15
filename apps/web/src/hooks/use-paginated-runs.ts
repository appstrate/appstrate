// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { canReadRuns } from "@appstrate/core/permissions";
import { client } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useCurrentOrgId } from "./use-org";
import { useCurrentSpaceId } from "./use-current-space";
import { usePermissions } from "./use-permissions";
import { paginatedRunsKeys } from "../lib/query-keys";
import { ACROSS_SPACES_POLL_MS } from "../lib/across-spaces";
import type { EnrichedRun, ListEnvelope } from "@appstrate/shared-types";
import type { RunStatus } from "@appstrate/core/run-status";

export type RunKindFilter = "all" | "package" | "inline";

interface UsePaginatedRunsOptions {
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
  limit: number;
  offset: number;
}

/**
 * Whether the previous page's rows stay on screen while the next loads: yes while PAGING and
 * SEARCHING, no when a filter changed. The key ends with `search, limit, offset`
 * (`paginatedRunsKeys.list`); the segments before them are the filters.
 */
export function keepsRunRows(previousKey: readonly unknown[], currentKey: readonly unknown[]) {
  const filters = (key: readonly unknown[]) => [...key.slice(0, -3), key[key.length - 2]];
  const current = filters(currentKey);
  const previous = filters(previousKey);
  return (
    previous.length === current.length && previous.every((segment, i) => segment === current[i])
  );
}

export function usePaginatedRuns({
  packageId,
  scheduleId,
  user,
  kind,
  status,
  search,
  unread,
  spanning,
  enabled = true,
  limit,
  offset,
}: UsePaginatedRunsOptions) {
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const { can } = usePermissions();
  // Every door guards on `requireRunsRead`; a schedule's runs also on `schedules:read`.
  const canRead = canReadRuns(can) && (!scheduleId || can("schedules:read"));

  // One value in the key: an array keys on identity, so a fresh `["failed"]` each render is a new entry.
  const statusKey = status && status.length > 0 ? status.join(",") : undefined;
  const statusQuery = status && status.length > 0 ? status : undefined;

  // The org route serves the global view only; inside an agent or a schedule the space is theirs.
  const acrossSpaces = !scheduleId && !packageId && !!spanning;

  const endpoint = scheduleId
    ? `/schedules/${scheduleId}/runs`
    : packageId
      ? `/agents/${packageId}/runs`
      : `/runs`;

  // use-global-run-sync and the run mutations invalidate by the key prefix.
  const currentKey = acrossSpaces
    ? paginatedRunsKeys.acrossSpaces(orgId, user, kind, statusKey, unread, search, limit, offset)
    : paginatedRunsKeys.list(
        orgId,
        spaceId,
        endpoint,
        user,
        kind,
        statusKey,
        unread,
        search,
        limit,
        offset,
      );

  return useQuery({
    queryKey: currentKey,
    queryFn: () =>
      fetchRunPage({
        packageId,
        scheduleId,
        user,
        kind,
        status: statusQuery,
        search,
        unread,
        acrossOrgId: acrossSpaces && orgId ? orgId : undefined,
        limit,
        offset,
      }),
    placeholderData: (prev, prevQuery) =>
      prevQuery && keepsRunRows(prevQuery.queryKey, currentKey) ? prev : undefined,
    // Each row's space grants it server-side; the current space's gate does not apply.
    enabled: enabled && (acrossSpaces ? !!orgId : canRead && !!spaceId),
    // Other spaces' runs, new ones included, reach no SSE stream here (`ACROSS_SPACES_POLL_MS`).
    refetchInterval: acrossSpaces ? ACROSS_SPACES_POLL_MS : undefined,
  });
}

/** One page's question: the hook's filters, and the org when it spans its spaces. */
type RunPageRequest = Omit<UsePaginatedRunsOptions, "spanning" | "enabled"> & {
  acrossOrgId?: string;
};

/**
 * One page, from the door the request names. `user`/`kind`/`unread` exist only on the global
 * view; `acrossOrgId` moves it to the org route. Exported for its test.
 */
export async function fetchRunPage({
  packageId,
  scheduleId,
  user,
  kind,
  status,
  search,
  unread,
  acrossOrgId,
  limit,
  offset,
}: RunPageRequest): Promise<ListEnvelope<EnrichedRun>> {
  if (scheduleId) {
    const { data } = await client.GET("/api/schedules/{id}/runs", {
      params: {
        path: { id: scheduleId },
        query: { limit, offset, status, q: search || undefined },
      },
    });
    return data!;
  }
  if (packageId) {
    const { scope, name } = splitPackageRef(packageId);
    const { data } = await client.GET("/api/agents/{scope}/{name}/runs", {
      params: {
        path: { scope, name },
        query: { limit, offset, status, q: search || undefined },
      },
    });
    return data!;
  }
  const query = {
    limit,
    offset,
    user,
    kind: kind && kind !== "all" ? kind : undefined,
    status,
    q: search || undefined,
    unread: unread || undefined,
  };
  if (acrossOrgId) {
    const { data } = await client.GET("/api/orgs/{orgId}/runs", {
      params: { path: { orgId: acrossOrgId }, query },
    });
    return data!;
  }
  const { data } = await client.GET("/api/runs", { params: { query } });
  return data!;
}
