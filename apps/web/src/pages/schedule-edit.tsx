// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePermissions } from "../hooks/use-permissions";
import {
  useScheduleById,
  useUpdateSchedule,
  useDeleteSchedule,
  useScheduleFormDeps,
} from "../hooks/use-schedules";
import { useConnectionProfiles, useAppProfiles } from "../hooks/use-connection-profiles";
import { ScheduleForm } from "../components/schedule-form";
import type { ForeignProfile } from "../components/combined-profile-select";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState } from "../components/page-states";

export function ScheduleEditPage() {
  const { t } = useTranslation(["agents", "common"]);
  const { isMember } = usePermissions();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();

  const { data: schedule, isLoading, error } = useScheduleById(id);
  const deps = useScheduleFormDeps(schedule?.packageId);
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();

  const { data: userProfiles } = useConnectionProfiles();
  const { data: appProfiles } = useAppProfiles();

  // Build foreign profile when the schedule's profile belongs to another user
  const foreignProfile = useMemo<ForeignProfile | undefined>(() => {
    if (!schedule) return undefined;
    const connectionProfileId = schedule.connectionProfileId;
    const inUser = userProfiles?.some((p) => p.id === connectionProfileId) ?? false;
    const inApp = appProfiles?.some((p) => p.id === connectionProfileId) ?? false;
    if (inUser || inApp) return undefined;
    if (schedule.profileType !== "user" || !schedule.profileName) return undefined;
    return {
      id: connectionProfileId,
      name: schedule.profileName,
      ownerName: schedule.profileOwnerName ?? "",
    };
  }, [schedule, userProfiles, appProfiles]);

  if (!isMember) return null;
  if (isLoading) return <LoadingState />;
  if (error || !schedule) return <ErrorState message={error?.message} />;

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
        inputSchema={deps?.inputSchema}
        configSchema={deps?.configSchema}
        persistedConfig={deps?.persistedConfig ?? {}}
        persistedModelId={deps?.persistedModelId ?? null}
        persistedProxyId={deps?.persistedProxyId ?? null}
        persistedVersion={deps?.persistedVersion ?? null}
        packageId={schedule.packageId}
        blockedMessage={deps?.hasFileInputs ? t("schedule.fileInputBlocked") : undefined}
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
