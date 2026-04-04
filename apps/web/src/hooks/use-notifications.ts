// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import type { Run } from "@appstrate/shared-types";

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

export function useUnreadCountsByAgent() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["unread-counts-by-agent", orgId],
    queryFn: async () => {
      const data = await api<{ counts: Record<string, number> }>(
        "/notifications/unread-counts-by-agent",
      );
      return data.counts;
    },
    refetchInterval: 30_000,
  });
}

export function useAllRuns(page: number, limit = 20) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  const offset = page * limit;
  return useQuery({
    queryKey: ["all-runs", orgId, appId, page, limit],
    queryFn: async () => {
      return api<{ runs: Run[]; total: number }>(`/runs?limit=${limit}&offset=${offset}`);
    },
    enabled: !!orgId && !!appId,
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (runId: string) => {
      return api<{ ok: boolean }>(`/notifications/read/${runId}`, { method: "PUT" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["unread-count"] });
      qc.invalidateQueries({ queryKey: ["unread-counts-by-agent"] });
      qc.invalidateQueries({ queryKey: ["all-runs"] });
      qc.invalidateQueries({ queryKey: ["paginated-runs"] });
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["run"] });
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
      qc.invalidateQueries({ queryKey: ["unread-counts-by-agent"] });
      qc.invalidateQueries({ queryKey: ["all-runs"] });
      qc.invalidateQueries({ queryKey: ["paginated-runs"] });
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["run"] });
    },
  });
}
