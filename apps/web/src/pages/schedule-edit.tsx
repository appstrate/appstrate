// SPDX-License-Identifier: Apache-2.0

import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePermissions } from "../hooks/use-permissions";
import {
  useScheduleById,
  useUpdateSchedule,
  useDeleteSchedule,
  useScheduleFormDeps,
} from "../hooks/use-schedules";
import { ScheduleForm } from "../components/schedule-form";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState } from "../components/page-states";

export function ScheduleEditPage() {
  const { t } = useTranslation(["agents", "common"]);
  const { isAdmin } = usePermissions();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();

  const { data: schedule, isLoading, error } = useScheduleById(id);
  const deps = useScheduleFormDeps(schedule?.packageId);
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();

  if (!isAdmin) return null;
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
          name: schedule.name ?? "",
          cron_expression: schedule.cron_expression,
          timezone: schedule.timezone ?? "UTC",
          enabled: schedule.enabled ?? true,
          input: schedule.input ?? {},
          config_override: schedule.config_override ?? null,
          model_id_override: schedule.model_id_override ?? null,
          proxy_id_override: schedule.proxy_id_override ?? null,
          version_override: schedule.version_override ?? null,
          connection_overrides: schedule.connection_overrides ?? null,
        }}
        defaultActorLabel={schedule.actor_name}
        inputSchema={deps?.inputSchema}
        configSchema={deps?.configSchema}
        persistedConfig={deps?.persistedConfig ?? {}}
        persistedModelId={deps?.persistedModelId ?? null}
        persistedProxyId={deps?.persistedProxyId ?? null}
        persistedVersion={deps?.persistedVersion ?? null}
        packageId={schedule.packageId}
        agentIntegrations={deps?.agentIntegrations ?? []}
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
      />
    </div>
  );
}
