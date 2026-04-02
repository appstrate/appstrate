// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { Run } from "@appstrate/shared-types";

interface PaginatedResult {
  runs: Run[];
  total: number;
}

interface UsePaginatedRunsOptions {
  packageId?: string;
  scheduleId?: string;
  user?: "me";
  limit: number;
  offset: number;
}

export function usePaginatedRuns({
  packageId,
  scheduleId,
  user,
  limit,
  offset,
}: UsePaginatedRunsOptions) {
  const orgId = useCurrentOrgId();

  const endpoint = scheduleId
    ? `/schedules/${scheduleId}/runs`
    : packageId
      ? `/agents/${packageId}/runs`
      : `/runs`;

  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  if (user) params.set("user", user);

  return useQuery({
    queryKey: ["paginated-runs", orgId, endpoint, user, limit, offset],
    queryFn: async () => {
      return api<PaginatedResult>(`${endpoint}?${params.toString()}`);
    },
    placeholderData: (prev) => prev,
    enabled: scheduleId ? !!scheduleId : packageId ? !!packageId : true,
  });
}
