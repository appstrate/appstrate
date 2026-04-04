// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePermissions } from "../hooks/use-permissions";
import { usePackageDetail } from "../hooks/use-packages";
import { useScheduleById, useUpdateSchedule, useDeleteSchedule } from "../hooks/use-schedules";
import { useConnectionProfiles, useOrgProfiles } from "../hooks/use-connection-profiles";
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
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();

  const { data: userProfiles } = useConnectionProfiles();
  const { data: orgProfiles } = useOrgProfiles();

  // Build foreign profile when the schedule's profile belongs to another user
  const foreignProfile = useMemo<ForeignProfile | undefined>(() => {
    if (!schedule) return undefined;
    const profileId = schedule.connectionProfileId;
    const inUser = userProfiles?.some((p) => p.id === profileId) ?? false;
    const inOrg = orgProfiles?.some((p) => p.id === profileId) ?? false;
    if (inUser || inOrg) return undefined;
    if (schedule.profileType !== "user" || !schedule.profileName) return undefined;
    return {
      id: profileId,
      name: schedule.profileName,
      ownerName: schedule.profileOwnerName ?? "",
    };
  }, [schedule, userProfiles, orgProfiles]);

  if (!isMember) return null;
  if (isLoading) return <LoadingState />;
  if (error || !schedule) return <ErrorState message={error?.message} />;

  const inputSchema = agentDetail?.input?.schema;
  const hasFileInputs =
    inputSchema?.properties && Object.values(inputSchema.properties).some(isFileField);

  const scheduleName = schedule.name || t("schedule.unnamed");

  return (
    <>
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
        }}
        inputSchema={inputSchema}
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
    </>
  );
}
