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

export function useSchedules(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["schedules", orgId, packageId],
    queryFn: async () => {
      return api<Schedule[]>(`/flows/${packageId}/schedules`);
    },
    enabled: !!packageId,
  });
}

function invalidateSchedules(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["schedules"] });
}

export function useCreateSchedule(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      name?: string;
      cronExpression: string;
      timezone?: string;
      input?: Record<string, unknown>;
    }) => {
      return api<Schedule>(`/flows/${packageId}/schedules`, {
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
