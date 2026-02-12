import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { api } from "../api";
import type { Schedule } from "@appstrate/shared-types";

export function useAllSchedules() {
  return useQuery({
    queryKey: ["schedules"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("flow_schedules")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return data;
    },
  });
}

export function useSchedules(flowId: string | undefined) {
  return useQuery({
    queryKey: ["schedules", flowId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("flow_schedules")
        .select("*")
        .eq("flow_id", flowId!)
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return data;
    },
    enabled: !!flowId,
  });
}

function invalidateSchedules(qc: ReturnType<typeof useQueryClient>, flowId?: string) {
  qc.invalidateQueries({ queryKey: ["schedules"] });
  if (flowId) qc.invalidateQueries({ queryKey: ["schedules", flowId] });
}

// Mutations still go through the API (croner sync needed on the backend)

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
