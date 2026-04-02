// SPDX-License-Identifier: Apache-2.0

import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePermissions } from "../hooks/use-permissions";
import { usePackageDetail } from "../hooks/use-packages";
import { useScheduleById, useUpdateSchedule, useDeleteSchedule } from "../hooks/use-schedules";
import { ScheduleForm } from "../components/schedule-form";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState } from "../components/page-states";
import { isFileField } from "@appstrate/core/form";

export function ScheduleEditPage() {
  const { t } = useTranslation(["flows", "common"]);
  const { isMember } = usePermissions();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();

  const { data: schedule, isLoading, error } = useScheduleById(id);
  const { data: flowDetail } = usePackageDetail("flow", schedule?.packageId || undefined);
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();

  if (!isMember) return null;
  if (isLoading) return <LoadingState />;
  if (error || !schedule) return <ErrorState message={error?.message} />;

  const inputSchema = flowDetail?.input?.schema;
  const hasFileInputs =
    inputSchema?.properties && Object.values(inputSchema.properties).some(isFileField);

  const scheduleName = schedule.name || t("schedule.unnamed");

  return (
    <>
      <PageHeader
        title={t("schedule.titleEdit")}
        emoji="📅"
        breadcrumbs={[
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
      />
    </>
  );
}
