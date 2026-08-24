// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { schemaHasFileFields } from "@appstrate/core/form";
import { client, type paths } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import { usePackageDetail } from "./use-packages";
import { useAgentModel } from "./use-models";
import type { ModelGenerationSettings } from "@appstrate/core/model-generation";
import { useAgentProxy } from "./use-proxies";
import { onMutationError } from "./use-mutations";
import { scheduleKeys } from "../lib/query-keys";
import type { AgentDetail, ScheduleWireDto, EnrichedSchedule } from "@appstrate/shared-types";

// `useScheduleRuns` used to live here: the schedule CARD fetched a schedule's
// runs purely to count active/unread/last-number, once per card. Those three
// counters now ride on the schedule itself (`EnrichedSchedule.running_runs` /
// `unread_count` / `last_run_number`), and the only remaining consumer of the
// endpoint is `<RunList scheduleId>` on the schedule-detail page, which fetches
// it through `usePaginatedRuns`. The `scheduleKeys.runs` cache key is still
// invalidated by `use-global-run-sync` for that list.

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
      model_id_override?: string | null;
      generation_config_override?: ModelGenerationSettings | null;
      proxy_id_override?: string | null;
      version_override?: string | null;
      connection_overrides?: Record<string, string> | null;
      actor?: { user_id?: string; end_user_id?: string };
    }): Promise<ScheduleWireDto> => {
      const { scope, name } = splitPackageRef(packageId);
      const { data: created } = await client.POST("/api/agents/{scope}/{name}/schedules", {
        params: { path: { scope, name } },
        // Spec body types `input` as a bare object.
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
      model_id_override?: string | null;
      generation_config_override?: ModelGenerationSettings | null;
      proxy_id_override?: string | null;
      version_override?: string | null;
      connection_overrides?: Record<string, string> | null;
      actor?: { user_id?: string; end_user_id?: string };
    }): Promise<ScheduleWireDto> => {
      const { data: updated } = await client.PUT("/api/schedules/{id}", {
        params: { path: { id } },
        // Spec body types `input` as a bare object.
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

interface ScheduleFormDeps {
  /**
   * Full input wrapper (schema + ui_hints + file_constraints + property_order)
   * — the launch surfaces feed this to `<SchemaForm>` so version-pinned input
   * renders with full fidelity, not just the bare schema (#770). It also
   * carries the per-application layers (`values` + `locked_fields`), so a
   * consumer needing those reads them off this same object rather than a
   * second prop that could drift from it.
   */
  inputWrapper: AgentDetail["input"];
  persistedModelId: string | null;
  persistedGenerationConfig: ModelGenerationSettings | null;
  persistedProxyId: string | null;
  persistedVersion: string | null;
  hasFileInputs: boolean;
  /**
   * Agent's declared integration deps (#199) — drives the schedule
   * connection-overrides picker. Empty when the agent has no
   * integrations.
   */
  agentIntegrations: Array<{ id: string; tools?: string[] | "*" }>;
  /**
   * Agent's declared skill dependencies — drives the per-skill dependency
   * override picker. Version-pinned when `version` is passed (#770).
   */
  skills: Array<{ id: string; version?: string; name?: string }>;
}

/**
 * Aggregates the agent-detail / model / proxy lookups that both
 * `ScheduleCreatePage` and `ScheduleEditPage` feed into `<ScheduleForm>`.
 *
 * `deps` is `null` until the agent detail has landed — or when no agent is
 * selected — so a consumer can never mount a form on settings it does not have
 * yet. `error` is the agent-detail query's failure: a deleted agent or a
 * revoked permission never lets the detail land, so a page that only watched
 * `deps` would spin forever. They ride on ONE hook because they are two reads
 * of the same query — split across two hooks the arguments had to be kept in
 * sync by hand, and a `version` passed to one but not the other silently
 * reported the wrong query's error.
 *
 * `version` (#770) pins the agent-detail projection to a published version so
 * the input / integrations / skills the form renders match the version the run
 * will execute. Omitted → `draft` (the editor working copy).
 */
export function useScheduleFormDeps(
  packageId: string | undefined,
  version?: string,
): { deps: ScheduleFormDeps | null; error: Error | null } {
  const { data: agentDetail, error } = usePackageDetail("agent", packageId, { version });
  const { data: agentModel } = useAgentModel(packageId);
  const { data: agentProxy } = useAgentProxy(packageId);

  // `deps` stays null until the AGENT DETAIL itself lands, not merely until an
  // agent is picked: `ScheduleForm` seeds its input state once, in a `useState`
  // initialiser, and a form mounted on empty settings would seed a field that
  // has since been locked — unremovable through the UI and refused on save
  // (400 `locked_input_field`). `key={schedule.id}` means no remount when the
  // detail arrives, so the only safe answer while it is in flight is "not yet".
  if (!packageId || !agentDetail) return { deps: null, error };

  const integrationDeps = (agentDetail.dependencies?.integrations ?? []).map((d) => ({
    id: d.id,
    ...(d.tools ? { tools: d.tools } : {}),
  }));
  const skillDeps = (agentDetail.dependencies?.skills ?? []).map((s) => ({
    id: s.id,
    ...(s.version ? { version: s.version } : {}),
    ...(s.name ? { name: s.name } : {}),
  }));
  return {
    deps: {
      // The detail's own object — a fresh literal here would change identity on
      // every render and defeat the launch form's memoized partition.
      inputWrapper: agentDetail.input,
      persistedModelId: agentModel?.modelId ?? null,
      persistedGenerationConfig: agentModel?.generation ?? null,
      persistedProxyId: agentProxy?.proxyId ?? null,
      persistedVersion: agentDetail.version ?? null,
      hasFileInputs: schemaHasFileFields(agentDetail.input.schema),
      agentIntegrations: integrationDeps,
      skills: skillDeps,
    },
    error,
  };
}
