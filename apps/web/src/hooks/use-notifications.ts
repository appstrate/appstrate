// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";

export function useUnreadCount() {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["unread-count", orgId, applicationId],
    queryFn: async () => {
      const data = await api<{ count: number }>("/notifications/unread-count");
      return data.count;
    },
    refetchInterval: 30_000,
    enabled: !!applicationId,
  });
}

export function useUnreadCountsByAgent() {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["unread-counts-by-agent", orgId, applicationId],
    queryFn: async () => {
      const data = await api<{ counts: Record<string, number> }>(
        "/notifications/unread-counts-by-agent",
      );
      return data.counts;
    },
    refetchInterval: 30_000,
    enabled: !!applicationId,
  });
}

export function invalidateRunAndNotificationQueries(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["unread-count"] });
  qc.invalidateQueries({ queryKey: ["unread-counts-by-agent"] });
  qc.invalidateQueries({ queryKey: ["paginated-runs"] });
  qc.invalidateQueries({ queryKey: ["runs"] });
  qc.invalidateQueries({ queryKey: ["run"] });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (runId: string) => {
      return api<{ ok: boolean }>(`/notifications/read/${runId}`, { method: "PUT" });
    },
    onSuccess: () => invalidateRunAndNotificationQueries(qc),
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      return api<{ updated: number }>("/notifications/read-all", { method: "PUT" });
    },
    onSuccess: () => invalidateRunAndNotificationQueries(qc),
  });
}
