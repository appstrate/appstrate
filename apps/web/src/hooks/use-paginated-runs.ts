// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { canReadRuns } from "@appstrate/core/permissions";
import { client } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useCurrentOrgId } from "./use-org";
import { useCurrentSpaceId } from "./use-current-space";
import { usePermissions } from "./use-permissions";
import { paginatedRunsKeys } from "../lib/query-keys";
import type { EnrichedRun, ListEnvelope } from "@appstrate/shared-types";
import type { RunStatus } from "@appstrate/core/run-status";

export type RunKindFilter = "all" | "package" | "inline";

interface UsePaginatedRunsOptions {
  packageId?: string;
  scheduleId?: string;
  user?: "me";
  kind?: RunKindFilter;
  /**
   * `RunStatus`, not `string`: `GET /api/runs` rejects a value outside the enum
   * with a 400 instead of quietly returning every status, so a typo here has to
   * be a compile error rather than a runtime surprise. Several statuses travel
   * as one comma-separated value — "everything that broke" is one question.
   */
  status?: RunStatus[];
  /** Free text, matched server-side against the agent, the error and the run number. */
  search?: string;
  limit: number;
  offset: number;
}

/**
 * Whether the rows of the previous page stay on screen while the next one
 * loads: yes while PAGING and while SEARCHING (no skeleton per keystroke), no
 * when a filter changed, so rows read under other filters never sit under the
 * chips just ticked. The key ends with `search, limit, offset`
 * (`paginatedRunsKeys.list`); the segments around them are the filters.
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
  limit,
  offset,
}: UsePaginatedRunsOptions) {
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const { can } = usePermissions();
  // Every door guards on `requireRunsRead`; a schedule's runs also on `schedules:read`.
  const canRead = canReadRuns(can) && (!scheduleId || can("schedules:read"));

  // Key segment only — the typed call below selects the matching spec path.
  // One value on the wire, so one value in the key: an array would key on its
  // identity, and a fresh `["failed"]` each render is a fresh cache entry.
  const statusKey = status && status.length > 0 ? status.join(",") : undefined;
  const statusQuery = status && status.length > 0 ? status : undefined;

  const endpoint = scheduleId
    ? `/schedules/${scheduleId}/runs`
    : packageId
      ? `/agents/${packageId}/runs`
      : `/runs`;

  // use-global-run-sync and the run mutations invalidate by the
  // ["paginated-runs"] prefix.
  const currentKey = paginatedRunsKeys.list(
    orgId,
    spaceId,
    endpoint,
    user,
    kind,
    statusKey,
    search,
    limit,
    offset,
  );

  return useQuery({
    queryKey: currentKey,
    // `user`/`kind` exist only on the global /api/runs view.
    queryFn: async (): Promise<ListEnvelope<EnrichedRun>> => {
      if (scheduleId) {
        const { data } = await client.GET("/api/schedules/{id}/runs", {
          params: {
            path: { id: scheduleId },
            query: { limit, offset, status: statusQuery, q: search || undefined },
          },
        });
        return data!;
      }
      if (packageId) {
        const { scope, name } = splitPackageRef(packageId);
        const { data } = await client.GET("/api/agents/{scope}/{name}/runs", {
          params: {
            path: { scope, name },
            query: { limit, offset, status: statusQuery, q: search || undefined },
          },
        });
        return data!;
      }
      const { data } = await client.GET("/api/runs", {
        params: {
          query: {
            limit,
            offset,
            user,
            kind: kind && kind !== "all" ? kind : undefined,
            status: statusQuery,
            q: search || undefined,
          },
        },
      });
      return data!;
    },
    placeholderData: (prev, prevQuery) =>
      prevQuery && keepsRunRows(prevQuery.queryKey, currentKey) ? prev : undefined,
    enabled: canRead && !!spaceId,
  });
}
