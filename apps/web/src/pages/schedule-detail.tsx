// SPDX-License-Identifier: Apache-2.0

import { Alert } from "@appstrate/ui/components/alert";
import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePermissions } from "../hooks/use-permissions";
import { useCanReach } from "../hooks/use-can-reach";
import { ConfirmModal } from "../components/confirm-modal";
import { Button } from "@appstrate/ui/components/button";
import { AlertDescription } from "@appstrate/ui/components/alert";
import { DetailTabs, DetailTabPanel, type DetailTab } from "../components/detail-tabs";
import { DetailSectionCard } from "../components/detail-section-card";
import { Fact, FactGrid } from "@appstrate/ui/components/fact-grid";
import { ManifestFacts } from "../components/package-manifest/manifest-fact";
import { RoleLimitNotice } from "../components/role-limit-notice";
import { PageActionsMenu } from "../components/page-actions-menu";
import { DetailBar } from "../components/detail-bar";
import { DisabledReasonTooltip } from "../components/disabled-reason-tooltip";
import { ResourceErrorState, EmptyState } from "../components/page-states";
import { ScheduleDetailSkeleton, SettingsSkeleton } from "../components/loading-skeletons";
import { JsonView } from "../components/json-view";
import { ActorLabel } from "../components/actor-label";
import { Badge } from "@appstrate/ui/components/badge";
import { ScopedRunList } from "../components/scoped-run-list";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { ScheduleStatusBadge } from "../components/schedule-status-badge";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { useScheduleById, useDeleteSchedule } from "../hooks/use-schedules";
import { useCanWriteSchedule } from "../hooks/use-can-write-schedule";
import { isQueryInFlight } from "../lib/query-state";
import { useAgents } from "../hooks/use-packages";
import { canReadRuns } from "@appstrate/core/permissions";
import { ScheduleActionsMenu, ScheduleSettings } from "../components/schedule-settings";
import {
  scheduleNextRunAt,
  scheduleSettingsHref,
  type ScheduleSettingsSection,
} from "../lib/schedule-options";
import { formatDateField } from "../lib/format-date";
import { parseCron } from "../lib/cron-frequency";
import { describeFrequency } from "../lib/frequency-summary";
import {
  Pause,
  Clock,
  CalendarClock,
  FileInput,
  CirclePlay,
  LayoutGrid,
  Play,
  Settings2,
} from "lucide-react";

type ScheduleTab = "details" | "runs" | "settings";
const SCHEDULE_TABS: readonly ScheduleTab[] = ["details", "runs", "settings"];

export function ScheduleDetailPage() {
  const { t } = useTranslation(["agents", "common"]);
  const { can } = usePermissions();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const scheduleQuery = useScheduleById(id);
  const { data: schedule, error } = scheduleQuery;
  const deleteSchedule = useDeleteSchedule();
  const mayWrite = useCanWriteSchedule(schedule);

  // A schedule's runs are runs: `schedules:read` alone does not list them.
  // The tab stays for every role; without the permission its content says so.
  const readsRuns = canReadRuns(can);
  const [activeTab, setActiveTab] = useTabWithHash(SCHEDULE_TABS, "details");
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (isQueryInFlight(scheduleQuery)) return <ScheduleDetailSkeleton />;
  if (error || !schedule) return <ResourceErrorState error={error} />;
  const tabs: DetailTab<ScheduleTab>[] = [
    { value: "details", label: t("detail.overview.summary"), icon: LayoutGrid },
    { value: "runs", label: t("common:nav.runs"), icon: Play },
    { value: "settings", label: t("common:nav.settings"), icon: Settings2 },
  ];
  const disabledReason = schedule.disabled_reason
    ? t(`schedule.disabledReason.${schedule.disabled_reason}`)
    : null;

  return (
    <div>
      <DetailTabs value={activeTab} onChange={setActiveTab}>
        <DetailBar
          title={schedule.name || t("schedule.unnamed")}
          icon={
            <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-[10px]">
              <CalendarClock className="size-5" aria-hidden />
            </span>
          }
          badge={<ScheduleStatusBadge schedule={schedule} />}
          parent={{ label: t("common:nav.schedules"), href: "/schedules" }}
          tabs={tabs}
          actions={
            <>
              {/* A schedule running as ANOTHER member is an org owner/admin
                  act: the page deed stays where it always is, disabled,
                  and says why. */}
              {can("schedules:write") && !mayWrite && (
                <DisabledReasonTooltip reason={t("schedule.memberGoverned")}>
                  <PageActionsMenu disabled />
                </DisabledReasonTooltip>
              )}
              {can("schedules:write") && mayWrite && (
                <ScheduleActionsMenu
                  schedule={schedule}
                  onDelete={() => setConfirmOpen(true)}
                  deletePending={deleteSchedule.isPending}
                />
              )}
            </>
          }
        />
        {/* Disabled by the platform, not by a person: say why in the band
            between the header and the tabs, where the agent page says what
            blocks it. A lost connection is repaired in the form's connection
            choice, so the alert opens it. */}
        {disabledReason && (
          <Alert variant="warning" className="mb-4">
            <Pause aria-hidden />
            <AlertDescription className="flex items-start justify-between gap-3">
              <span className="min-w-0">{disabledReason}</span>
              {mayWrite && schedule.disabled_reason?.startsWith("connection_") && (
                <Button
                  size="sm"
                  variant="outline"
                  className="-my-1.5 shrink-0"
                  onClick={() => navigate(scheduleSettingsHref(schedule.id, "connections"))}
                >
                  {t("schedule.chooseConnections")}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}
        <DetailTabPanel value="runs">
          {readsRuns ? (
            <ScheduleHistory schedule={schedule} />
          ) : (
            <RoleLimitNotice>{t("schedule.roleLimit.runs")}</RoleLimitNotice>
          )}
        </DetailTabPanel>

        <DetailTabPanel value="details">
          <ScheduleParams schedule={schedule} />
        </DetailTabPanel>

        <DetailTabPanel value="settings" flush>
          {/* The settings seed their fields once: never from a list row that may be stale. */}
          {scheduleQuery.isPlaceholderData ? (
            <div className="p-6">
              <SettingsSkeleton />
            </div>
          ) : (
            <ScheduleSettings schedule={schedule} />
          )}
        </DetailTabPanel>
      </DetailTabs>

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("schedule.deleteTitle")}
        confirmLabel={t("common:btn.delete")}
        description={t("schedule.deleteConfirm")}
        isPending={deleteSchedule.isPending}
        onConfirm={() => {
          deleteSchedule.mutate(schedule.id, {
            onSuccess: () => {
              setConfirmOpen(false);
              navigate("/schedules");
            },
          });
        }}
      />
    </div>
  );
}

// ─── Params Tab ──────────────────────────────────────────

function ScheduleParams({
  schedule,
}: {
  schedule: NonNullable<ReturnType<typeof useScheduleById>["data"]>;
}) {
  const { t } = useTranslation(["agents"]);
  const agentsQuery = useAgents();
  const { data: agents } = agentsQuery;
  const agentsPending = isQueryInFlight(agentsQuery);
  const canReach = useCanReach();
  const agentPath = `/agents/${schedule.packageId}`;
  const nextRunAt = scheduleNextRunAt(schedule);
  const agentDisplayName =
    agents?.find((f) => f.id === schedule.packageId)?.display_name ?? schedule.packageId;
  const input = schedule.input;
  const navigate = useNavigate();
  const open = (section: ScheduleSettingsSection) => ({
    label: t("schedule.settings.open"),
    onClick: () => navigate(scheduleSettingsHref(schedule.id, section)),
  });

  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <DetailSectionCard
        title={t("run.infoExecution")}
        icon={CirclePlay}
        headerAction={open("execution")}
      >
        <FactGrid columns={2}>
          <Fact label={t("schedule.agent")}>
            {agentsPending ? (
              <Skeleton className="h-4 w-32" />
            ) : canReach(agentPath) ? (
              <Link className="text-primary hover:underline" to={agentPath}>
                {agentDisplayName}
              </Link>
            ) : (
              agentDisplayName
            )}
          </Fact>
          <Fact label={t("schedule.paramActor")}>
            {schedule.actor_name ? (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <ActorLabel
                  actor_type={schedule.actor_type}
                  actor_name={schedule.actor_name}
                  iconSize="size-3.5"
                />
                {schedule.actor_type && (
                  <Badge variant="outline" className="px-1 py-0 text-[10px]">
                    {t(
                      schedule.actor_type === "end_user"
                        ? "actorSelect.badgeEndUser"
                        : "actorSelect.badgeMember",
                    )}
                  </Badge>
                )}
              </span>
            ) : (
              "–"
            )}
          </Fact>
          <Fact label={t("run.infoVersion")}>
            {schedule.version_override || t("schedule.inheritedVersion")}
          </Fact>
        </FactGrid>
      </DetailSectionCard>
      <DetailSectionCard
        title={t("schedule.settings.recurrence")}
        icon={CalendarClock}
        headerAction={open("general")}
      >
        <ManifestFacts
          facts={[
            {
              labelKey: "schedule.settings.recurrence",
              value:
                describeFrequency(parseCron(schedule.cron_expression)) ?? schedule.cron_expression,
            },
            { labelKey: "schedule.timezone", value: schedule.timezone },
            {
              labelKey: "schedule.paramNextRun",
              value: nextRunAt
                ? formatDateField(nextRunAt, "datetime", schedule.timezone)
                : t("schedule.noNextRun"),
            },
            {
              labelKey: "schedule.paramLastRun",
              value: schedule.last_run_at
                ? formatDateField(schedule.last_run_at, "datetime", schedule.timezone)
                : t("schedule.notRunYet"),
            },
          ]}
        />
      </DetailSectionCard>
      <DetailSectionCard
        title={t("detail.configuration.inputsShort")}
        icon={FileInput}
        headerAction={open("inputs")}
        className="lg:col-span-2"
      >
        <p className="text-muted-foreground mb-4 text-sm">{t("schedule.inputHint")}</p>
        {input && Object.keys(input).length > 0 ? (
          <JsonView data={input} />
        ) : (
          <p className="text-muted-foreground text-sm">{t("schedule.noInput")}</p>
        )}
      </DetailSectionCard>
    </div>
  );
}

// ─── History Tab ─────────────────────────────────────────

function ScheduleHistory({
  schedule,
}: {
  schedule: NonNullable<ReturnType<typeof useScheduleById>["data"]>;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const { data: agents } = useAgents();
  const agentName =
    agents?.find((f) => f.id === schedule.packageId)?.display_name ?? schedule.packageId;

  return (
    <ScopedRunList
      scope={{ scheduleId: schedule.id, agentName }}
      emptyState={
        <div className="p-6">
          <EmptyState message={t("schedule.noRuns")} icon={Clock} compact />
        </div>
      }
    />
  );
}
