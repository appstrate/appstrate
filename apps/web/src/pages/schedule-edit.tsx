// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePermissions } from "../hooks/use-permissions";
import { usePackageDetail } from "../hooks/use-packages";
import { useScheduleById, useUpdateSchedule, useDeleteSchedule } from "../hooks/use-schedules";
import { useConnectionProfiles, useAppProfiles } from "../hooks/use-connection-profiles";
import { useAgentModel } from "../hooks/use-models";
import { useAgentProxy } from "../hooks/use-proxies";
import { ScheduleForm } from "../components/schedule-form";
import type { ForeignProfile } from "../components/combined-profile-select";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState } from "../components/page-states";
import { isFileField } from "@appstrate/core/form";

export function ScheduleEditPage() {
  const { t } = useTranslation(["agents", "common"]);
  const { isMember } = usePermissions();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();

  const { data: schedule, isLoading, error } = useScheduleById(id);
  const { data: agentDetail } = usePackageDetail("agent", schedule?.packageId || undefined);
  const { data: agentModel } = useAgentModel(schedule?.packageId || undefined);
  const { data: agentProxy } = useAgentProxy(schedule?.packageId || undefined);
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();

  const { data: userProfiles } = useConnectionProfiles();
  const { data: appProfiles } = useAppProfiles();

  // Build foreign profile when the schedule's profile belongs to another user
  const foreignProfile = useMemo<ForeignProfile | undefined>(() => {
    if (!schedule) return undefined;
    const profileId = schedule.connectionProfileId;
    const inUser = userProfiles?.some((p) => p.id === profileId) ?? false;
    const inApp = appProfiles?.some((p) => p.id === profileId) ?? false;
    if (inUser || inApp) return undefined;
    if (schedule.profileType !== "user" || !schedule.profileName) return undefined;
    return {
      id: profileId,
      name: schedule.profileName,
      ownerName: schedule.profileOwnerName ?? "",
    };
  }, [schedule, userProfiles, appProfiles]);

  if (!isMember) return null;
  if (isLoading) return <LoadingState />;
  if (error || !schedule) return <ErrorState message={error?.message} />;

  const inputSchema = agentDetail?.input?.schema;
  const hasFileInputs =
    inputSchema?.properties && Object.values(inputSchema.properties).some(isFileField);

  const scheduleName = schedule.name || t("schedule.unnamed");

  return (
    <div className="p-6">
      <PageHeader
        title={t("schedule.titleEdit")}
        emoji="📅"
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("schedule.breadcrumbList"), href: "/schedules" },
          { label: scheduleName, href: `/schedules/${id}` },
          { label: t("schedule.breadcrumbEdit") },
        ]}
      />

      <ScheduleForm
        key={schedule.id}
        mode="edit"
        defaultValues={{
          connectionProfileId: schedule.connectionProfileId,
          name: schedule.name ?? "",
          cronExpression: schedule.cronExpression,
          timezone: schedule.timezone ?? "UTC",
          enabled: schedule.enabled ?? true,
          input: (schedule.input ?? {}) as Record<string, unknown>,
          configOverride: (schedule.configOverride ?? null) as Record<string, unknown> | null,
          modelIdOverride: schedule.modelIdOverride ?? null,
          proxyIdOverride: schedule.proxyIdOverride ?? null,
          versionOverride: schedule.versionOverride ?? null,
        }}
        inputSchema={inputSchema}
        configSchema={agentDetail?.config?.schema ?? undefined}
        persistedConfig={(agentDetail?.config?.current ?? {}) as Record<string, unknown>}
        persistedModelId={agentModel?.modelId ?? null}
        persistedProxyId={agentProxy?.proxyId ?? null}
        persistedVersion={agentDetail?.version ?? null}
        packageId={schedule.packageId}
        blockedMessage={hasFileInputs ? t("schedule.fileInputBlocked") : undefined}
        isPending={updateSchedule.isPending}
        onSubmit={(data) => {
          updateSchedule.mutate(
            { id: schedule.id, ...data },
            { onSuccess: () => navigate(`/schedules/${schedule.id}`) },
          );
        }}
        onDelete={() => {
          deleteSchedule.mutate(schedule.id, {
            onSuccess: () => navigate("/schedules"),
          });
        }}
        onCancel={() => navigate(-1)}
        foreignProfile={foreignProfile}
      />
    </div>
  );
}
