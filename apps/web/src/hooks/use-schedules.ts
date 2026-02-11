import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { Schedule } from "@appstrate/shared-types";

export function useAllSchedules() {
  return useQuery({
    queryKey: ["schedules"],
    queryFn: async () => {
      const data = await api<{ schedules: Schedule[] }>("/schedules");
      return data.schedules;
    },
  });
}

export function useSchedules(flowId: string | undefined) {
  return useQuery({
    queryKey: ["schedules", flowId],
    queryFn: async () => {
      const data = await api<{ schedules: Schedule[] }>(`/flows/${flowId}/schedules`);
      return data.schedules;
    },
    enabled: !!flowId,
  });
}

function invalidateSchedules(qc: ReturnType<typeof useQueryClient>, flowId?: string) {
  qc.invalidateQueries({ queryKey: ["schedules"] });
  if (flowId) qc.invalidateQueries({ queryKey: ["schedules", flowId] });
}

export function useCreateSchedule(flowId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      name?: string;
      cronExpression: string;
      timezone?: string;
      input?: Record<string, unknown>;
    }) => {
      return api<Schedule>(`/flows/${flowId}/schedules`, {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => invalidateSchedules(qc, flowId),
  });
}

export function useUpdateSchedule(flowId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...data
    }: {
      id: string;
      name?: string;
      cronExpression?: string;
      timezone?: string;
      input?: Record<string, unknown>;
      enabled?: boolean;
    }) => {
      return api<Schedule>(`/schedules/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => invalidateSchedules(qc, flowId),
  });
}

export function useDeleteSchedule(flowId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return api(`/schedules/${id}`, { method: "DELETE" });
    },
    onSuccess: () => invalidateSchedules(qc, flowId),
  });
}
