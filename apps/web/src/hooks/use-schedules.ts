// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import { onMutationError } from "./use-mutations";
import type { Schedule, EnrichedSchedule, Run } from "@appstrate/shared-types";

export function useScheduleExecutions(scheduleId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["schedule-runs", orgId, scheduleId],
    queryFn: async () => {
      const result = await api<{ runs: Run[]; total: number }>(`/schedules/${scheduleId}/runs`);
      return result.runs;
    },
    enabled: !!scheduleId,
  });
}

export function useAllSchedules() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["schedules", orgId],
    queryFn: async () => {
      return api<EnrichedSchedule[]>("/schedules");
    },
  });
}

export function useScheduleById(id: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["schedule", orgId, id],
    queryFn: async () => {
      return api<EnrichedSchedule>(`/schedules/${id}`);
    },
    enabled: !!id,
  });
}

export function useSchedules(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["schedules", orgId, packageId],
    queryFn: async () => {
      return api<EnrichedSchedule[]>(`/agents/${packageId}/schedules`);
    },
    enabled: !!packageId,
  });
}

function invalidateSchedules(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["schedules"] });
  qc.invalidateQueries({ queryKey: ["schedule"] });
}

export function useCreateSchedule(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      connectionProfileId: string;
      name?: string;
      cronExpression: string;
      timezone?: string;
      input?: Record<string, unknown>;
    }) => {
      return api<Schedule>(`/agents/${packageId}/schedules`, {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => invalidateSchedules(qc),
    onError: onMutationError,
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
      connectionProfileId?: string;
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
    onError: onMutationError,
  });
}

export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return api(`/schedules/${id}`, { method: "DELETE" });
    },
    onSuccess: () => invalidateSchedules(qc),
    onError: onMutationError,
  });
}
