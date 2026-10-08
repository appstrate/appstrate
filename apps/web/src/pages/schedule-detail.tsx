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
import { FactGrid } from "../components/package-manifest/manifest-fact";
import { ListToolbar } from "../components/list-toolbar";
import { runStatusValues, type RunStatus } from "@appstrate/core/run-status";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@appstrate/ui/components/dropdown-menu";
import { PageHeader } from "../components/page-header";
import { DisabledReasonTooltip } from "../components/disabled-reason-tooltip";
import { LoadingState, ResourceErrorState, EmptyState } from "../components/page-states";
import { JsonView } from "../components/json-view";
import { RunList } from "../components/run-list";
import { NextRunPreview } from "../components/next-run-preview";
import { usePaginatedRuns } from "../hooks/use-paginated-runs";
import { ScheduleStatusBadge } from "../components/schedule-status-badge";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { useScheduleById, useUpdateSchedule, useDeleteSchedule } from "../hooks/use-schedules";
import { useCanWriteSchedule } from "../hooks/use-can-write-schedule";
import { isQueryInFlight } from "../lib/query-state";
import { toastScheduleConnectionChoice } from "../lib/mutation-error";
import { useAgents } from "../hooks/use-packages";
import { canReadRuns } from "@appstrate/core/permissions";
import { formatDateField } from "../lib/format-date";
import {
  ChevronDown,
  Pencil,
  Trash2,
  Play,
  Pause,
  Clock,
  CalendarClock,
  FileInput,
  CirclePlay,
} from "lucide-react";

type ScheduleTab = "details" | "runs";

export function ScheduleDetailPage() {
  const { t } = useTranslation(["agents", "common"]);
  const { can } = usePermissions();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const scheduleQuery = useScheduleById(id);
  const { data: schedule, error } = scheduleQuery;
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();
  const mayWrite = useCanWriteSchedule(schedule);

  // A schedule's runs are runs: `schedules:read` alone does not list them.
  const readsRuns = canReadRuns(can);
  const tabs: readonly ScheduleTab[] = readsRuns ? ["details", "runs"] : ["details"];
  const [activeTab, setActiveTab] = useTabWithHash(tabs, "details");
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (isQueryInFlight(scheduleQuery)) return <LoadingState />;
  if (error || !schedule) return <ResourceErrorState error={error} />;
  const disabledReason = schedule.disabled_reason
    ? t(`schedule.disabledReason.${schedule.disabled_reason}`)
    : null;

  const handleToggle = () => {
    updateSchedule.mutate(
      { id: schedule.id, enabled: !schedule.enabled },
      { onError: toastScheduleConnectionChoice },
    );
  };

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
            { label: schedule.name || t("schedule.unnamed"), href: `/schedules/${schedule.id}` },
            {
              label: activeTab === "details" ? t("detail.overview.summary") : t("schedule.tabRuns"),
            },
          ]}
          actions={
            <>
              <ScheduleStatusBadge schedule={schedule} />
              {/* A schedule running as ANOTHER member is an org owner/admin
                  act (#1611): the page deed stays where it always is, disabled,
                  and says why. */}
              {can("schedules:write") && !mayWrite && (
                <DisabledReasonTooltip reason={t("schedule.memberGoverned")}>
                  <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5" disabled>
                    {t("pageActions.label", { ns: "common" })}
                    <ChevronDown size={16} />
                  </Button>
                </DisabledReasonTooltip>
              )}
              {can("schedules:write") && mayWrite && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5">
                      {t("pageActions.label", { ns: "common" })}
                      <ChevronDown size={16} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => navigate(`/schedules/${id}/edit`)}>
                      <Pencil size={14} />
                      {t("schedule.edit")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={handleToggle} disabled={updateSchedule.isPending}>
                      {schedule.enabled ? <Pause size={14} /> : <Play size={14} />}
                      {schedule.enabled ? t("schedule.disable") : t("schedule.enable")}
                    </DropdownMenuItem>
                    {can("schedules:delete") && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onSelect={() => setConfirmOpen(true)}
                          disabled={deleteSchedule.isPending}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 size={14} />
                          {t("schedule.delete")}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
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
                  onClick={() => navigate(`/schedules/${schedule.id}/edit#connections`)}
                >
                  {t("schedule.chooseConnections")}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}
        <DetailTabsList className="mt-6 mb-3">
          <DetailTabsTrigger value="details">{t("detail.overview.summary")}</DetailTabsTrigger>
          {readsRuns && <DetailTabsTrigger value="runs">{t("schedule.tabRuns")}</DetailTabsTrigger>}
        </DetailTabsList>

        {readsRuns && (
          <TabsContent value="runs" className="bg-card mt-0 rounded-lg border p-6 shadow-sm">
            <ScheduleHistory schedule={schedule} />
          </TabsContent>
        )}

        <TabsContent value="details" className="bg-card mt-0 rounded-lg border p-6 shadow-sm">
          <ScheduleParams schedule={schedule} />
        </TabsContent>
      </Tabs>

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("btn.confirm", { ns: "common" })}
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

  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <DetailSectionCard headerInside title={t("run.infoExecution")} icon={CirclePlay}>
        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-muted-foreground text-xs">{t("schedule.paramAgent")}</dt>
            <dd className="mt-1 text-sm">
              {canReach(agentPath) ? (
                <Link className="text-primary hover:underline" to={agentPath}>
                  {agentDisplayName}
                </Link>
              ) : (
                agentDisplayName
              )}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted-foreground text-xs">{t("schedule.paramActor")}</dt>
            <dd className="mt-1 text-sm break-words">{schedule.actor_name || "–"}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted-foreground text-xs">{t("run.infoVersion")}</dt>
            <dd className="mt-1 text-sm">
              {schedule.version_override || t("schedule.inheritedVersion")}
            </dd>
          </div>
        </dl>
      </DetailSectionCard>
      <DetailSectionCard headerInside title={t("schedule.timing")} icon={CalendarClock}>
        <FactGrid
          facts={[
            { labelKey: "schedule.paramCron", value: schedule.cron_expression },
            { labelKey: "schedule.paramTimezone", value: schedule.timezone },
            {
              labelKey: "schedule.paramNextRun",
              value:
                schedule.enabled && schedule.next_run_at
                  ? formatDateField(schedule.next_run_at)
                  : t("schedule.noNextRun"),
            },
            {
              labelKey: "schedule.paramLastRun",
              value: schedule.last_run_at
                ? formatDateField(schedule.last_run_at)
                : t("schedule.notRunYet"),
            },
          ]}
        />
      </DetailSectionCard>
      <DetailSectionCard
        headerInside
        title={t("schedule.tabInput")}
        icon={FileInput}
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
  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<RunStatus[]>([]);
  const { data: agents } = useAgents();
  const agentName =
    agents?.find((f) => f.id === schedule.packageId)?.display_name ?? schedule.packageId;

  const isActive = schedule.enabled;

  // Use the same hook as RunList so React Query deduplicates the fetch.
  // We only need the first run for the "next run" preview row.
  const { data } = usePaginatedRuns({
    scheduleId: schedule.id,
    limit: 20,
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
    !search && statuses.length === 0 && isActive && showNext && schedule.next_run_at ? (
      <NextRunPreview
        runNumber={(firstExec?.runNumber ?? 0) + 1}
        agentName={agentName}
        schedule_name={schedule.name || t("schedule.unnamed")}
        next_run_at={schedule.next_run_at}
      />
    ) : null;

  return (
    <RunList
      scheduleId={schedule.id}
      pageSize={12}
      status={statuses}
      search={search}
      tableSurface="integrated"
      toolbar={({ columns }) => (
        <ListToolbar
          placement="panel"
          panelFiltersAdjacent
          columns={columns}
          search={{ value: search, onChange: setSearch, placeholder: t("detail.runsSearch") }}
          filters={[
            {
              id: "status",
              label: t("runs.filterStatus"),
              values: statuses,
              options: runStatusValues.map((value) => ({
                value,
                label: t(`status.${value}`, { ns: "common" }),
              })),
              onChange: (values) => setStatuses(values as RunStatus[]),
            },
          ]}
          onReset={() => {
            setSearch("");
            setStatuses([]);
          }}
        />
      )}
      fixedAgentName={agentName}
      firstPageBanner={previewRow}
      emptyState={
        <div>
          {previewRow}
          <div className="p-6">
            <EmptyState
              message={t(search || statuses.length ? "runs.emptyFiltered" : "schedule.noRuns")}
              icon={Clock}
              compact
            />
          </div>
        </div>
      }
    />
  );
}
