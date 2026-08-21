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
  // The agent detail is a SEPARATE query from the schedule: mounting the form
  // before it lands would seed the input state from empty settings, keeping a
  // since-locked field the user can no longer remove (400 `locked_input_field`
  // on every save). `key={schedule.id}` gives no remount to repair it.
  if (!deps) return <LoadingState />;

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
          model_id_override: schedule.model_id_override ?? null,
          generation_config_override: schedule.generation_config_override ?? null,
          proxy_id_override: schedule.proxy_id_override ?? null,
          version_override: schedule.version_override ?? null,
          connection_overrides: schedule.connection_overrides ?? null,
          // Seed the actor with the schedule's current identity so the select
          // shows the real value (not a "default" placeholder). Submit still
          // only sends it when it differs from currentActor.
          actor: {
            user_id: schedule.userId ?? undefined,
            end_user_id: schedule.endUserId ?? undefined,
          },
        }}
        currentActor={{
          user_id: schedule.userId ?? undefined,
          end_user_id: schedule.endUserId ?? undefined,
        }}
        inputWrapper={deps.inputWrapper}
        persistedModelId={deps.persistedModelId}
        persistedGenerationConfig={deps.persistedGenerationConfig}
        persistedProxyId={deps.persistedProxyId}
        persistedVersion={deps.persistedVersion}
        packageId={schedule.packageId}
        agentIntegrations={deps.agentIntegrations}
        blockedMessage={deps.hasFileInputs ? t("schedule.fileInputBlocked") : undefined}
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
