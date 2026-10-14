// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePermissions } from "../hooks/use-permissions";
import { useCanReach } from "../hooks/use-can-reach";
import { ConfirmModal } from "../components/confirm-modal";
import { Button } from "@appstrate/ui/components/button";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Tabs, TabsContent } from "@appstrate/ui/components/tabs";
import { DetailTabsList, DetailTabsTrigger } from "../components/agent-detail/agent-local-tabs";
import { DetailSectionCard } from "../components/detail-section-card";
import { Fact, FactGrid } from "../components/fact-grid";
import { ManifestFacts } from "../components/package-manifest/manifest-fact";
import { RoleLimitNotice } from "../components/role-limit-notice";
import { PageActionsMenu } from "../components/page-actions-menu";
import { PageHeader } from "../components/page-header";
import { DisabledReasonTooltip } from "../components/disabled-reason-tooltip";
import { ResourceErrorState, EmptyState } from "../components/page-states";
import { DetailPageSkeleton } from "../components/loading-skeletons";
import { JsonView } from "../components/json-view";
import { ActorLabel } from "../components/actor-label";
import { Badge } from "@appstrate/ui/components/badge";
import { ScopedRunList } from "../components/scoped-run-list";
import { NextRunPreview } from "../components/next-run-preview";
import { usePaginatedRuns } from "../hooks/use-paginated-runs";
import { ScheduleStatusBadge } from "../components/schedule-status-badge";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { useScheduleById, useDeleteSchedule } from "../hooks/use-schedules";
import { useCanWriteSchedule } from "../hooks/use-can-write-schedule";
import { isQueryInFlight } from "../lib/query-state";
import { useAgents } from "../hooks/use-packages";
import { canReadRuns } from "@appstrate/core/permissions";
import { ScheduleActionsMenu, ScheduleSettings } from "../components/schedule-settings";
import { scheduleSettingsHref, type ScheduleSettingsSection } from "../lib/schedule-options";
import { formatDateField } from "../lib/format-date";
import { parseCron } from "../lib/cron-frequency";
import { describeFrequency } from "../lib/frequency-summary";
import { scheduleDetailPath } from "../lib/package-paths";
import { Pause, Clock, CalendarClock, FileInput, CirclePlay } from "lucide-react";

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

  if (isQueryInFlight(scheduleQuery))
    return (
      <DetailPageSkeleton
        breadcrumbs={[{ label: t("schedule.breadcrumbList"), href: "/schedules" }]}
      />
    );
  if (error || !schedule) return <ResourceErrorState error={error} />;
  const disabledReason = schedule.disabled_reason
    ? t(`schedule.disabledReason.${schedule.disabled_reason}`)
    : null;

  return (
    <div>
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ScheduleTab)}>
        <PageHeader
          title={schedule.name || t("schedule.unnamed")}
          titleClassName="text-xl"
          wrapActions
          icon={
            <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-[10px]">
              <CalendarClock className="size-5" aria-hidden />
            </span>
          }
          breadcrumbs={[
            { label: t("schedule.breadcrumbList"), href: "/schedules" },
            {
              label: schedule.name || t("schedule.unnamed"),
              href: scheduleDetailPath(schedule.id),
            },
            {
              label:
                activeTab === "details"
                  ? t("detail.overview.summary")
                  : activeTab === "runs"
                    ? t("schedule.tabRuns")
                    : t("schedule.tabSettings"),
            },
          ]}
          actions={
            <>
              <ScheduleStatusBadge schedule={schedule} />
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
        <DetailTabsList>
          <DetailTabsTrigger value="details">{t("detail.overview.summary")}</DetailTabsTrigger>
          <DetailTabsTrigger value="runs">{t("schedule.tabRuns")}</DetailTabsTrigger>
          <DetailTabsTrigger value="settings">{t("schedule.tabSettings")}</DetailTabsTrigger>
        </DetailTabsList>

        <TabsContent value="runs" className="bg-card mt-0 rounded-lg border p-6 shadow-sm">
          {readsRuns ? (
            <ScheduleHistory schedule={schedule} />
          ) : (
            <RoleLimitNotice>{t("schedule.roleLimit.runs")}</RoleLimitNotice>
          )}
        </TabsContent>

        <TabsContent value="details" className="bg-card mt-0 rounded-lg border p-6 shadow-sm">
          <ScheduleParams schedule={schedule} />
        </TabsContent>

        <TabsContent
          value="settings"
          className="bg-card mt-0 overflow-clip rounded-lg border shadow-sm"
        >
          <ScheduleSettings schedule={schedule} />
        </TabsContent>
      </Tabs>

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("schedule.deleteTitle")}
        confirmLabel={t("schedule.delete")}
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
  const { data: agents } = useAgents();
  const canReach = useCanReach();
  const agentPath = `/agents/${schedule.packageId}`;
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
          <Fact label={t("schedule.paramAgent")}>
            {canReach(agentPath) ? (
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
        title={t("schedule.timing")}
        icon={CalendarClock}
        headerAction={open("recurrence")}
      >
        <ManifestFacts
          facts={[
            {
              labelKey: "schedule.settings.recurrence",
              value:
                describeFrequency(parseCron(schedule.cron_expression)) ?? schedule.cron_expression,
            },
            { labelKey: "schedule.paramTimezone", value: schedule.timezone },
            {
              labelKey: "schedule.paramNextRun",
              value:
                schedule.enabled && schedule.next_run_at
                  ? formatDateField(schedule.next_run_at, "datetime", schedule.timezone)
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
        title={t("schedule.tabInput")}
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

  const isActive = schedule.enabled;

  // The same query ScopedRunList makes for its first page (12 rows), so React
  // Query serves both from one fetch.
  // We only need the first run for the "next run" preview row.
  const { data } = usePaginatedRuns({
    scheduleId: schedule.id,
    limit: 12,
    offset: 0,
  });
  const firstExec = data?.data?.[0];

  // Show the fake "next run" row only if the last run started > 30s ago.
  const lastStartedAt = firstExec?.started_at;
  const [showNext, setShowNext] = useState(true);

  /* eslint-disable react-hooks/set-state-in-effect -- syncing with wall clock timer */
  useEffect(() => {
    if (!lastStartedAt) {
      setShowNext(true);
      return;
    }
    const elapsed = Date.now() - new Date(lastStartedAt).getTime();
    if (elapsed > 30_000) {
      setShowNext(true);
      return;
    }
    setShowNext(false);
    const timer = setTimeout(() => setShowNext(true), 30_000 - elapsed);
    return () => clearTimeout(timer);
  }, [lastStartedAt]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const previewRow =
    isActive && showNext && schedule.next_run_at ? (
      <NextRunPreview
        runNumber={(firstExec?.runNumber ?? 0) + 1}
        agentName={agentName}
        schedule_name={schedule.name || t("schedule.unnamed")}
        next_run_at={schedule.next_run_at}
        timezone={schedule.timezone}
      />
    ) : null;

  return (
    <ScopedRunList
      scope={{ scheduleId: schedule.id, agentName }}
      banner={previewRow}
      emptyState={
        <div>
          {previewRow}
          <div className="p-6">
            <EmptyState message={t("schedule.noRuns")} icon={Clock} compact />
          </div>
        </div>
      }
    />
  );
}
