// SPDX-License-Identifier: Apache-2.0

import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  useScheduleById,
  useUpdateSchedule,
  useDeleteSchedule,
  useScheduleFormDeps,
} from "../hooks/use-schedules";
import { useCanWriteSchedule } from "../hooks/use-can-write-schedule";
import { isQueryInFlight } from "../lib/query-state";
import { ScheduleForm } from "../components/schedule-form";
import { scheduleConnectionChoices } from "../lib/connection-choice";
import { PageHeader } from "../components/page-header";
import {
  LoadingState,
  ErrorState,
  ResourceErrorState,
  EmptyState,
} from "../components/page-states";
import { NoAccessState } from "../components/route-gate";
import { usePermissions } from "../hooks/use-permissions";
import { Lock } from "lucide-react";

export function ScheduleEditPage() {
  const { t } = useTranslation(["agents", "common"]);
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();

  const scheduleQuery = useScheduleById(id);
  const { data: schedule, error } = scheduleQuery;
  const { deps, error: depsError, denied } = useScheduleFormDeps(schedule?.packageId);
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();
  const { can } = usePermissions();
  const mayWrite = useCanWriteSchedule(schedule);

  if (isQueryInFlight(scheduleQuery)) return <LoadingState />;
  if (error || !schedule) return <ResourceErrorState error={error} />;
  // Reached by URL on a schedule running as another member: every write would 403.
  // Drawn like `NoAccessState`: the shell pads the page, the state needs no frame.
  if (!mayWrite) return <EmptyState message={t("schedule.memberGoverned")} icon={Lock} />;
  // The agent detail is a SEPARATE query from the schedule: mounting the form
  // before it lands would seed the input state from empty settings, keeping a
  // since-locked field the user can no longer remove (400 `locked_input_field`
  // on every save). `key={schedule.id}` gives no remount to repair it. When
  // that query FAILS (deleted agent, revoked permission) the detail never
  // lands, so waiting is waiting forever — say so instead.
  if (depsError) return <ErrorState error={depsError} />;
  if (denied) return <NoAccessState />;
  if (!deps) return <LoadingState />;

  const scheduleName = schedule.name || t("schedule.unnamed");

  return (
    <div>
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
          name: schedule.name ?? "",
          cron_expression: schedule.cron_expression,
          timezone: schedule.timezone,
          enabled: schedule.enabled,
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
            userId: schedule.userId ?? undefined,
            endUserId: schedule.endUserId ?? undefined,
          },
        }}
        currentActor={{
          userId: schedule.userId ?? undefined,
          endUserId: schedule.endUserId ?? undefined,
        }}
        inputWrapper={deps.inputWrapper}
        persistedModelId={deps.persistedModelId}
        persistedGenerationConfig={deps.persistedGenerationConfig}
        persistedProxyId={deps.persistedProxyId}
        homeWritable={deps.homeWritable}
        packageId={schedule.packageId}
        blockedMessage={deps.hasFileInputs ? t("schedule.fileInputBlocked") : undefined}
        isPending={updateSchedule.isPending}
        connectionChoices={scheduleConnectionChoices(updateSchedule.error)}
        onSubmit={(data) => {
          updateSchedule.mutate(
            { id: schedule.id, ...data },
            { onSuccess: () => navigate(`/schedules/${schedule.id}`) },
          );
        }}
        onDelete={
          can("schedules:delete")
            ? () =>
                deleteSchedule.mutate(schedule.id, {
                  onSuccess: () => navigate("/schedules"),
                })
            : undefined
        }
        onCancel={() => navigate(-1)}
      />
    </div>
  );
}
