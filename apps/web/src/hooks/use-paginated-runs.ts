// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { api, buildQs } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import type { Run } from "@appstrate/shared-types";

interface PaginatedResult {
  object: "list";
  data: Run[];
  total: number;
  hasMore: boolean;
}

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
  const appId = useCurrentApplicationId();

  const endpoint = scheduleId
    ? `/schedules/${scheduleId}/runs`
    : packageId
      ? `/agents/${packageId}/runs`
      : `/runs`;

  const qs = buildQs({
    limit,
    offset,
    user,
    kind: kind && kind !== "all" ? kind : undefined,
    status,
  });

  return useQuery({
    queryKey: ["paginated-runs", orgId, appId, endpoint, user, kind, status, limit, offset],
    queryFn: async () => {
      return api<PaginatedResult>(`${endpoint}${qs}`);
    },
    placeholderData: (prev) => prev,
    enabled: !!appId && (scheduleId ? !!scheduleId : packageId ? !!packageId : true),
  });
}
