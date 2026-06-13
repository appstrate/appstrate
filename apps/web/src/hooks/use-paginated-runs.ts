// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { client } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import { paginatedRunsKeys } from "../lib/query-keys";
import type { EnrichedRun, ListEnvelope } from "@appstrate/shared-types";

export type RunKindFilter = "all" | "package" | "inline";

interface UsePaginatedRunsOptions {
  packageId?: string;
  scheduleId?: string;
  user?: "me";
  kind?: RunKindFilter;
  status?: string;
  limit: number;
  offset: number;
}

export function usePaginatedRuns({
  packageId,
  scheduleId,
  user,
  kind,
  status,
  limit,
  offset,
}: UsePaginatedRunsOptions) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();

  // Key segment only — the typed call below selects the matching spec path.
  const endpoint = scheduleId
    ? `/schedules/${scheduleId}/runs`
    : packageId
      ? `/agents/${packageId}/runs`
      : `/runs`;

  return useQuery({
    // Key pinned to the legacy shape: use-global-run-sync (and run mutations)
    // invalidate by the ["paginated-runs"] prefix.
    queryKey: paginatedRunsKeys.list(
      orgId,
      applicationId,
      endpoint,
      user,
      kind,
      status,
      limit,
      offset,
    ),
    // `user`/`kind`/`status` are only declared (and only ever passed by
    // callers) on the global /api/runs view.
    queryFn: async (): Promise<ListEnvelope<EnrichedRun>> => {
      if (scheduleId) {
        const { data } = await client.GET("/api/schedules/{id}/runs", {
          params: { path: { id: scheduleId }, query: { limit, offset } },
        });
        return data!;
      }
      if (packageId) {
        const { scope, name } = splitPackageRef(packageId);
        const { data } = await client.GET("/api/agents/{scope}/{name}/runs", {
          params: { path: { scope, name }, query: { limit, offset } },
        });
        return data!;
      }
      const { data } = await client.GET("/api/runs", {
        params: {
          query: { limit, offset, user, kind: kind && kind !== "all" ? kind : undefined, status },
        },
      });
      return data!;
    },
    placeholderData: (prev) => prev,
    enabled: !!applicationId && (scheduleId ? !!scheduleId : packageId ? !!packageId : true),
  });
}
