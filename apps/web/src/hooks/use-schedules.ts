// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { schemaHasFileFields, type JSONSchemaObject } from "@appstrate/core/form";
import { client, type paths } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import { usePackageDetail } from "./use-packages";
import { useAgentModel } from "./use-models";
import { useAgentProxy } from "./use-proxies";
import { onMutationError } from "./use-mutations";
import { scheduleKeys } from "../lib/query-keys";
import type { ScheduleWireDto, EnrichedSchedule, EnrichedRun } from "@appstrate/shared-types";

export function useScheduleRuns(scheduleId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    // Key pinned to the legacy shape: use-global-run-sync invalidates
    // ["schedule-runs", orgId, applicationId, scheduleId] on SSE events.
    queryKey: scheduleKeys.runs(orgId, applicationId, scheduleId),
    queryFn: async (): Promise<EnrichedRun[]> => {
      const { data } = await client.GET("/api/schedules/{id}/runs", {
        params: { path: { id: scheduleId! } },
      });
      return data?.data ?? [];
    },
    enabled: !!scheduleId && !!applicationId,
  });
}

export function useAllSchedules() {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    // Key pinned to the legacy shape: use-global-run-sync invalidates by the
    // ["schedules", orgId, applicationId] prefix on SSE events.
    queryKey: scheduleKeys.list(orgId, applicationId),
    queryFn: async (): Promise<EnrichedSchedule[]> => {
      const { data } = await client.GET("/api/schedules");
      return data?.data ?? [];
    },
    enabled: !!orgId && !!applicationId,
  });
}

export function useScheduleById(id: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    // Key pinned to the legacy shape: use-global-run-sync invalidates
    // ["schedule", orgId, applicationId, scheduleId] on SSE events.
    queryKey: scheduleKeys.detail(orgId, applicationId, id),
    queryFn: async (): Promise<EnrichedSchedule> => {
      const { data } = await client.GET("/api/schedules/{id}", {
        params: { path: { id: id! } },
      });
      // Non-2xx throws via the client middleware, so `data` is defined here.
      return data!;
    },
    enabled: !!id && !!applicationId,
  });
}

export function useSchedules(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    // Key pinned to the legacy shape (under the ["schedules", orgId,
    // applicationId] prefix invalidated by use-global-run-sync).
    queryKey: scheduleKeys.listForAgent(orgId, applicationId, packageId),
    queryFn: async (): Promise<EnrichedSchedule[]> => {
      const { scope, name } = splitPackageRef(packageId!);
      const { data } = await client.GET("/api/agents/{scope}/{name}/schedules", {
        params: { path: { scope, name } },
      });
      return data?.data ?? [];
    },
    enabled: !!packageId && !!applicationId,
  });
}

function invalidateSchedules(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: scheduleKeys.listAll });
  qc.invalidateQueries({ queryKey: scheduleKeys.detailAll });
}

type CreateScheduleBody =
  paths["/api/agents/{scope}/{name}/schedules"]["post"]["requestBody"]["content"]["application/json"];
type UpdateScheduleBody =
  paths["/api/schedules/{id}"]["put"]["requestBody"]["content"]["application/json"];

export function useCreateSchedule(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      name?: string;
      cron_expression: string;
      timezone?: string;
      input?: Record<string, unknown>;
      config_override?: Record<string, unknown> | null;
      model_id_override?: string | null;
      proxy_id_override?: string | null;
      version_override?: string | null;
      connection_overrides?: Record<string, string> | null;
      actor?: { user_id?: string; end_user_id?: string };
    }): Promise<ScheduleWireDto> => {
      const { scope, name } = splitPackageRef(packageId);
      const { data: created } = await client.POST("/api/agents/{scope}/{name}/schedules", {
        params: { path: { scope, name } },
        // Spec body types `input`/`config_override` as bare objects.
        body: data as CreateScheduleBody,
      });
      return created!;
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
      name?: string;
      cron_expression?: string;
      timezone?: string;
      input?: Record<string, unknown>;
      enabled?: boolean;
      config_override?: Record<string, unknown> | null;
      model_id_override?: string | null;
      proxy_id_override?: string | null;
      version_override?: string | null;
      connection_overrides?: Record<string, string> | null;
      actor?: { user_id?: string; end_user_id?: string };
    }): Promise<ScheduleWireDto> => {
      const { data: updated } = await client.PUT("/api/schedules/{id}", {
        params: { path: { id } },
        // Spec body types `input`/`config_override` as bare objects.
        body: data as UpdateScheduleBody,
      });
      return updated!;
    },
    onSuccess: () => invalidateSchedules(qc),
    onError: onMutationError,
  });
}

export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await client.DELETE("/api/schedules/{id}", { params: { path: { id } } });
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
  /**
   * Agent's declared integration deps (#199) — drives the schedule
   * connection-overrides picker. Empty when the agent has no
   * integrations.
   */
  agentIntegrations: Array<{ id: string; tools?: string[] | "*" }>;
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
  const integrationDeps = (agentDetail?.dependencies?.integrations ?? []).map((d) => ({
    id: d.id,
    ...(d.tools ? { tools: d.tools } : {}),
  }));
  return {
    inputSchema,
    configSchema: agentDetail?.config?.schema ?? undefined,
    persistedConfig: agentDetail?.config?.current ?? {},
    persistedModelId: agentModel?.modelId ?? null,
    persistedProxyId: agentProxy?.proxyId ?? null,
    persistedVersion: agentDetail?.version ?? null,
    hasFileInputs: schemaHasFileFields(inputSchema),
    agentIntegrations: integrationDeps,
  };
}
