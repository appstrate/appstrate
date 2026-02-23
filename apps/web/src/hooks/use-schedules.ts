import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { Schedule } from "@appstrate/shared-types";

export function useAllSchedules() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["schedules", orgId],
    queryFn: async () => {
      return api<Schedule[]>("/schedules");
    },
  });
}

export function useSchedules(flowId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["schedules", orgId, flowId],
    queryFn: async () => {
      return api<Schedule[]>(`/flows/${flowId}/schedules`);
    },
    enabled: !!flowId,
  });
}

function invalidateSchedules(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["schedules"] });
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
    onSuccess: () => invalidateSchedules(qc),
  });
}

export function useUpdateSchedule() {
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
    onSuccess: () => invalidateSchedules(qc),
  });
}

export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return api(`/schedules/${id}`, { method: "DELETE" });
    },
    onSuccess: () => invalidateSchedules(qc),
  });
}
