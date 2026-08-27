// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { client } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import { paginatedRunsKeys } from "../lib/query-keys";
import type { EnrichedRun, ListEnvelope, RunStatus } from "@appstrate/shared-types";

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
  const applicationId = useCurrentApplicationId();

  // Key segment only — the typed call below selects the matching spec path.
  // One value on the wire, so one value in the key: an array would key on its
  // identity, and a fresh `["failed"]` each render is a fresh cache entry.
  const statusKey = status && status.length > 0 ? status.join(",") : undefined;

  const endpoint = scheduleId
    ? `/schedules/${scheduleId}/runs`
    : packageId
      ? `/agents/${packageId}/runs`
      : `/runs`;

  // Key pinned to the legacy shape: use-global-run-sync (and run mutations)
  // invalidate by the ["paginated-runs"] prefix.
  const currentKey = paginatedRunsKeys.list(
    orgId,
    applicationId,
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
          params: { path: { scope, name }, query: { limit, offset, status: statusKey } },
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
            status: statusKey,
            q: search || undefined,
          },
        },
      });
      return data!;
    },
    // Keep the rows on screen while PAGING, drop them when the filters change.
    // Blanket `(prev) => prev` did both, so ticking a status left the whole
    // unfiltered page sitting under a filter chip that was already on screen.
    // The offset is the last segment of the key; everything before it is what
    // the user asked for.
    placeholderData: (prev, prevQuery) => {
      const previousKey = prevQuery?.queryKey as unknown[] | undefined;
      if (!previousKey) return undefined;
      const sameQuestion = previousKey
        .slice(0, -1)
        .every((segment, i) => segment === (currentKey[i] as unknown));
      return sameQuestion ? prev : undefined;
    },
    enabled: !!applicationId && (scheduleId ? !!scheduleId : packageId ? !!packageId : true),
  });
}

/** One server-side aggregate for the agent overview's fixed 30-day window. */
export function useAgentRunActivity(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();

  return useQuery({
    queryKey: ["agent-run-activity", orgId, applicationId, packageId],
    queryFn: async () => {
      const { scope, name } = splitPackageRef(packageId!);
      const { data } = await client.GET("/api/agents/{scope}/{name}/run-activity", {
        params: { path: { scope, name } },
      });
      return data!;
    },
    enabled: !!orgId && !!applicationId && !!packageId,
  });
}
