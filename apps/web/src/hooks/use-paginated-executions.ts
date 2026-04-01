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
  user?: "me";
  limit: number;
  offset: number;
}

export function usePaginatedExecutions({
  packageId,
  scheduleId,
  user,
  limit,
  offset,
}: UsePaginatedExecutionsOptions) {
  const orgId = useCurrentOrgId();

  const endpoint = scheduleId
    ? `/schedules/${scheduleId}/executions`
    : packageId
      ? `/flows/${packageId}/executions`
      : `/executions`;

  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  if (user) params.set("user", user);

  return useQuery({
    queryKey: ["paginated-executions", orgId, endpoint, user, limit, offset],
    queryFn: async () => {
      return api<PaginatedResult>(`${endpoint}?${params.toString()}`);
    },
    placeholderData: (prev) => prev,
    enabled: scheduleId ? !!scheduleId : packageId ? !!packageId : true,
  });
}
