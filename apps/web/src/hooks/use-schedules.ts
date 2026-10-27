// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import i18n from "../i18n";
import { schemaHasFileFields } from "@appstrate/core/form";
import { client } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useCurrentOrgId } from "./use-org";
import { useCurrentSpaceId } from "./use-current-space";
import { usePermissions } from "./use-permissions";
import { packageSightPermissions } from "@appstrate/core/permissions";
import { usePackageDetail } from "./use-packages";
import { useAgentModel } from "./use-models";
import type { ModelGenerationSettings } from "@appstrate/core/model-generation";
import { useAgentProxy } from "./use-proxies";
import { scheduleKeys } from "../lib/query-keys";
import type { ScheduleCreateBody, ScheduleUpdateBody } from "../lib/schedule-payload";
import type { AgentDetail, EnrichedSchedule } from "@appstrate/shared-types";
import { useLaunchWarningsToast } from "./use-launch-warnings-toast";

// Some space roles (`runner`, custom roles) lack `schedules:read`: gate here so incidental
// surfaces (the dashboard) never fire a request the server is bound to refuse.
function useCanReadSchedules(): boolean {
  const { can } = usePermissions();
  return can("schedules:read");
}

export function useAllSchedules() {
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const canRead = useCanReadSchedules();
  return useQuery({
    // Key pinned: use-global-run-sync invalidates by this prefix on SSE events.
    queryKey: scheduleKeys.list(orgId, spaceId),
    queryFn: async (): Promise<EnrichedSchedule[]> => {
      const { data } = await client.GET("/api/schedules");
      return data?.data ?? [];
    },
    enabled: canRead && !!orgId && !!spaceId,
  });
}

export function useScheduleById(id: string | undefined) {
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const canRead = useCanReadSchedules();
  const qc = useQueryClient();
  return useQuery({
    // Key pinned: use-global-run-sync invalidates it on SSE events.
    queryKey: scheduleKeys.detail(orgId, spaceId, id),
    // The list caches the same enriched rows: show the page from it while the detail loads.
    placeholderData: () =>
      qc
        .getQueryData<EnrichedSchedule[]>(scheduleKeys.list(orgId, spaceId))
        ?.find((s) => s.id === id),
    queryFn: async (): Promise<EnrichedSchedule> => {
      const { data } = await client.GET("/api/schedules/{id}", {
        params: { path: { id: id! } },
      });
      // Non-2xx throws via the client middleware, so `data` is defined here.
      return data!;
    },
    enabled: canRead && !!id && !!spaceId,
  });
}

export function useSchedules(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const canRead = useCanReadSchedules();
  return useQuery({
    // Key pinned (under the prefix use-global-run-sync invalidates).
    queryKey: scheduleKeys.listForAgent(orgId, spaceId, packageId),
    queryFn: async (): Promise<EnrichedSchedule[]> => {
      const { scope, name } = splitPackageRef(packageId!);
      const { data } = await client.GET("/api/agents/{scope}/{name}/schedules", {
        params: { path: { scope, name } },
      });
      return data?.data ?? [];
    },
    enabled: canRead && !!packageId && !!spaceId,
  });
}

/**
 * Every cached schedule list and detail, across org/space — also used after a connection delete or
 * unshare.
 */
export function invalidateSchedules(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: scheduleKeys.listAll });
  qc.invalidateQueries({ queryKey: scheduleKeys.detailAll });
}

/** Says how many schedules removing a pin or a space default disabled, and refetches them. */
export function warnSchedulesDisabled(qc: ReturnType<typeof useQueryClient>, count: number) {
  toast.warning(i18n.t("agents:schedule.disabledUnnamed", { count }));
  invalidateSchedules(qc);
}

export function useCreateSchedule(packageId: string) {
  const qc = useQueryClient();
  const toastWarnings = useLaunchWarningsToast();
  return useMutation({
    mutationFn: async (body: ScheduleCreateBody) => {
      const { scope, name } = splitPackageRef(packageId);
      const { data: created } = await client.POST("/api/agents/{scope}/{name}/schedules", {
        params: { path: { scope, name } },
        body,
      });
      return created!;
    },
    onSuccess: (created) => {
      invalidateSchedules(qc);
      if (created.warnings) {
        toastWarnings({ kind: "schedule", userId: created.userId }, packageId, created.warnings);
      }
    },
  });
}

export function useUpdateSchedule() {
  const qc = useQueryClient();
  const toastWarnings = useLaunchWarningsToast();
  return useMutation({
    mutationFn: async ({ id, ...body }: ScheduleUpdateBody & { id: string }) => {
      const { data: updated } = await client.PATCH("/api/schedules/{id}", {
        params: { path: { id } },
        body,
      });
      return updated!;
    },
    onSuccess: (updated) => {
      invalidateSchedules(qc);
      if (updated.warnings) {
        toastWarnings(
          { kind: "schedule", userId: updated.userId },
          updated.packageId,
          updated.warnings,
        );
      }
    },
  });
}

export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await client.DELETE("/api/schedules/{id}", { params: { path: { id } } });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: scheduleKeys.listAll });
      // The page still showing the deleted schedule would re-read it, a 404: stale only.
      qc.invalidateQueries({ queryKey: scheduleKeys.detailAll, refetchType: "none" });
    },
  });
}

interface ScheduleFormDeps {
  /** Full input wrapper (schema + ui_hints + …) for `<SchemaForm>`; also carries the per-space layers (`values` + `locked_fields`). */
  inputWrapper: AgentDetail["input"];
  persistedModelId: string | null;
  persistedGenerationConfig: ModelGenerationSettings | null;
  persistedProxyId: string | null;
  /** Whether the caller may write the package: only they get the `draft` option (`403 draft_not_writable` otherwise). */
  homeWritable: boolean;
  hasFileInputs: boolean;
  /** Agent's declared integration deps (connection-overrides picker). */
  agentIntegrations: Array<{ id: string; tools?: string[] | "*"; scopes?: string[] }>;
  /** Agent's skill deps (override picker). `homeWritable` is the dependency's OWN `home_writable`: the server gates `draft` per skill. */
  skills: Array<{ id: string; version?: string; name?: string; homeWritable: boolean }>;
}

/**
 * Aggregates the agent-detail / model / proxy lookups the schedule forms and run options need.
 * `deps` is `null` until the agent detail lands, so no form mounts on settings it lacks; `error`
 * is that query's failure (a deleted agent never lets it land). They share ONE hook so `version`
 * cannot reach one read and not the other. `version` pins the projection to a published version;
 * omitted → the detail route's default (working copy for writers, latest published otherwise).
 */
export function useScheduleFormDeps(
  packageId: string | undefined,
  version?: string,
): { deps: ScheduleFormDeps | null; error: Error | null; denied: boolean } {
  const { data: agentDetail, error } = usePackageDetail("agent", packageId, { version });
  const { data: agentModel } = useAgentModel(packageId);
  const { data: agentProxy } = useAgentProxy(packageId);
  // The detail read gates itself: a caller who may not see the agent gets neither data nor error.
  const { can, ready } = usePermissions();
  const denied = !!packageId && ready && !packageSightPermissions("agent").some(can);

  // Null until the AGENT DETAIL lands: the forms seed their input state once in a `useState`
  // initialiser (no remount when it arrives), and one mounted early could seed a since-locked
  // field, refused on save (400 `locked_input_field`).
  if (!packageId || !agentDetail) return { deps: null, error, denied };

  const integrationDeps = agentDetail.dependencies.integrations.map((d) => ({
    id: d.id,
    ...(d.tools ? { tools: d.tools } : {}),
    ...(d.scopes ? { scopes: d.scopes } : {}),
  }));
  // `skills` is optional: a summary read (`agents:run` without `agents:read`) omits it.
  const skillDeps = (agentDetail.dependencies.skills ?? []).map((s) => ({
    id: s.id,
    homeWritable: s.home_writable,
    ...(s.version ? { version: s.version } : {}),
    ...(s.name ? { name: s.name } : {}),
  }));
  return {
    deps: {
      // The detail's own object: a fresh literal would defeat the launch form's memoized partition.
      inputWrapper: agentDetail.input,
      persistedModelId: agentModel?.modelId ?? null,
      persistedGenerationConfig: agentModel?.generation ?? null,
      persistedProxyId: agentProxy?.proxyId ?? null,
      homeWritable: agentDetail.home_writable,
      hasFileInputs: schemaHasFileFields(agentDetail.input.schema),
      agentIntegrations: integrationDeps,
      skills: skillDeps,
    },
    error,
    denied,
  };
}
