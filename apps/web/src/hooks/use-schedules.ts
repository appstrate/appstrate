// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { schemaHasFileFields, type JSONSchemaObject } from "@appstrate/core/form";
import { api, apiList } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import { usePackageDetail } from "./use-packages";
import { useAgentModel } from "./use-models";
import { useAgentProxy } from "./use-proxies";
import { onMutationError } from "./use-mutations";
import type { Schedule, EnrichedSchedule, Run } from "@appstrate/shared-types";

export function useScheduleRuns(scheduleId: string | undefined) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["schedule-runs", orgId, appId, scheduleId],
    queryFn: () => apiList<Run>(`/schedules/${scheduleId}/runs`),
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

export interface ScheduleFormDeps {
  inputSchema: JSONSchemaObject | undefined;
  configSchema: JSONSchemaObject | undefined;
  persistedConfig: Record<string, unknown>;
  persistedModelId: string | null;
  persistedProxyId: string | null;
  persistedVersion: string | null;
  hasFileInputs: boolean;
}

/**
 * Aggregates the agent-detail / model / proxy lookups that both
 * `ScheduleCreatePage` and `ScheduleEditPage` feed into `<ScheduleForm>`.
 * Returns `null` while inputs aren't ready or no agent is selected.
 */
export function useScheduleFormDeps(packageId: string | undefined): ScheduleFormDeps | null {
  const { data: agentDetail } = usePackageDetail("agent", packageId);
  const { data: agentModel } = useAgentModel(packageId);
  const { data: agentProxy } = useAgentProxy(packageId);

  if (!packageId) return null;

  const inputSchema = agentDetail?.input?.schema ?? undefined;
  return {
    inputSchema,
    configSchema: agentDetail?.config?.schema ?? undefined,
    persistedConfig: (agentDetail?.config?.current ?? {}) as Record<string, unknown>,
    persistedModelId: agentModel?.modelId ?? null,
    persistedProxyId: agentProxy?.proxyId ?? null,
    persistedVersion: agentDetail?.version ?? null,
    hasFileInputs: schemaHasFileFields(inputSchema),
  };
}
