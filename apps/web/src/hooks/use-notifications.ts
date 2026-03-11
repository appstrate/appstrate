import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { Execution } from "@appstrate/shared-types";

export function useUnreadCount() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["unread-count", orgId],
    queryFn: async () => {
      const data = await api<{ count: number }>("/notifications/unread-count");
      return data.count;
    },
    refetchInterval: 30_000,
  });
}

export function useUnreadCountsByFlow() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["unread-counts-by-flow", orgId],
    queryFn: async () => {
      const data = await api<{ counts: Record<string, number> }>(
        "/notifications/unread-counts-by-flow",
      );
      return data.counts;
    },
    refetchInterval: 30_000,
  });
}

export function useAllExecutions(page: number, limit = 20) {
  const orgId = useCurrentOrgId();
  const offset = page * limit;
  return useQuery({
    queryKey: ["all-executions", orgId, page, limit],
    queryFn: async () => {
      return api<{ executions: Execution[]; total: number }>(
        `/executions?limit=${limit}&offset=${offset}`,
      );
    },
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (executionId: string) => {
      return api<{ ok: boolean }>(`/notifications/read/${executionId}`, { method: "PUT" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["unread-count"] });
      qc.invalidateQueries({ queryKey: ["unread-counts-by-flow"] });
      qc.invalidateQueries({ queryKey: ["all-executions"] });
    },
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      return api<{ updated: number }>("/notifications/read-all", { method: "PUT" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["unread-count"] });
      qc.invalidateQueries({ queryKey: ["unread-counts-by-flow"] });
      qc.invalidateQueries({ queryKey: ["all-executions"] });
    },
  });
}
