import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { Execution } from "@appstrate/shared-types";

interface PaginatedResult {
  executions: Execution[];
  total: number;
}

interface UsePaginatedExecutionsOptions {
  packageId?: string;
  scheduleId?: string;
  limit: number;
  offset: number;
}

export function usePaginatedExecutions({
  packageId,
  scheduleId,
  limit,
  offset,
}: UsePaginatedExecutionsOptions) {
  const orgId = useCurrentOrgId();

  const endpoint = scheduleId
    ? `/schedules/${scheduleId}/executions`
    : packageId
      ? `/flows/${packageId}/executions`
      : `/executions`;

  return useQuery({
    queryKey: ["paginated-executions", orgId, endpoint, limit, offset],
    queryFn: async () => {
      return api<PaginatedResult>(`${endpoint}?limit=${limit}&offset=${offset}`);
    },
    placeholderData: (prev) => prev,
    enabled: scheduleId ? !!scheduleId : packageId ? !!packageId : true,
  });
}
