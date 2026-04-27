// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import { onMutationError } from "./use-mutations";
import type { Schedule, EnrichedSchedule, Run } from "@appstrate/shared-types";

export function useScheduleRuns(scheduleId: string | undefined) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["schedule-runs", orgId, appId, scheduleId],
    queryFn: async () => {
      const result = await api<{ object: "list"; data: Run[]; total: number; hasMore: boolean }>(
        `/schedules/${scheduleId}/runs`,
      );
      return result.data;
    },
    enabled: !!scheduleId && !!appId,
  });
}

export function useAllSchedules() {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["schedules", orgId, appId],
    queryFn: async () => {
      return api<EnrichedSchedule[]>("/schedules");
    },
    enabled: !!orgId && !!appId,
  });
}

export function useScheduleById(id: string | undefined) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["schedule", orgId, appId, id],
    queryFn: async () => {
      return api<EnrichedSchedule>(`/schedules/${id}`);
    },
    enabled: !!id && !!appId,
  });
}

export function useSchedules(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["schedules", orgId, appId, packageId],
    queryFn: async () => {
      return api<EnrichedSchedule[]>(`/agents/${packageId}/schedules`);
    },
    enabled: !!packageId && !!appId,
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
      configOverride?: Record<string, unknown> | null;
      modelIdOverride?: string | null;
      proxyIdOverride?: string | null;
      versionOverride?: string | null;
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
      configOverride?: Record<string, unknown> | null;
      modelIdOverride?: string | null;
      proxyIdOverride?: string | null;
      versionOverride?: string | null;
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
