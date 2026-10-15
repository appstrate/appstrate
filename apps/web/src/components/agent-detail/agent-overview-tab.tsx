// SPDX-License-Identifier: Apache-2.0

import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChartNoAxesCombined, Database, PlayCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import type { AgentDetail } from "@appstrate/shared-types";
import { useSchedules } from "../../hooks/use-schedules";
import { useAgentRunActivity } from "../../hooks/use-paginated-runs";
import { useAgentMemories, useAgentPinned } from "../../hooks/use-persistence";
import { Badge } from "../status-badge";
import { formatDateField } from "../../lib/format-date";
import { latestMemoryDate, runSuccessRate } from "../../lib/agent-overview";
import { runDetailPath } from "../../lib/package-paths";
import { agentSettingsHref } from "../../lib/settings-section-href";
import { searchOf } from "../../lib/url-search";
import { OperationalStat } from "../operational-stat";
import { DetailSectionCard } from "../detail-section-card";
import { AgentHealthSection } from "./agent-health-section";
import { Skeleton } from "@appstrate/ui/components/skeleton";

export function AgentOverviewTab({
  packageId,
  detail,
  version,
  isHistorical,
}: {
  packageId: string;
  detail: AgentDetail;
  version: string | undefined;
  isHistorical: boolean;
}) {
  const { t } = useTranslation("agents");
  if (isHistorical) {
    return (
      <div className="p-3">
        <p className="text-muted-foreground rounded-lg border p-4 text-sm">
          {t("detail.overview.historicalUnavailable")}
        </p>
      </div>
    );
  }
  return <OperationalSummary packageId={packageId} detail={detail} version={version} />;
}

/** The live counters, read only where they are shown. */
function OperationalSummary({
  packageId,
  detail,
  version,
}: {
  packageId: string;
  detail: AgentDetail;
  version: string | undefined;
}) {
  const { t, i18n } = useTranslation("agents");
  const location = useLocation();
  const {
    data: schedules,
    isLoading: schedulesLoading,
    isError: schedulesError,
    isSuccess: schedulesSuccess,
  } = useSchedules(packageId);
  const runActivity = useAgentRunActivity(packageId);
  const {
    data: memories,
    isLoading: memoriesLoading,
    isError: memoriesError,
  } = useAgentMemories(packageId);
  const {
    data: pinned,
    isLoading: pinnedLoading,
    isError: pinnedError,
  } = useAgentPinned(packageId);
  const nextSchedule = schedules?.find((schedule) => schedule.enabled && schedule.next_run_at);
  const activeScheduleCount = schedules?.filter((schedule) => schedule.enabled).length;
  const unknown = t("detail.overview.unknown");
  const latestMemory = pinned && memories ? latestMemoryDate(pinned, memories) : undefined;

  const activity = runActivity.data;
  const failedRunCount = activity ? activity.failed + activity.timeout : undefined;
  const successRate = activity ? runSuccessRate(activity) : null;
  const successRateLabel =
    successRate === null
      ? "—"
      : new Intl.NumberFormat(i18n.language, {
          style: "percent",
          maximumFractionDigits: 1,
        }).format(successRate);
  const destination = (hash: string, key?: string, value?: string) => {
    const search = new URLSearchParams(location.search);
    if (hash === "#runs") search.delete("agentRunStatus");
    if (hash === "#memory") search.delete("agentMemory");
    if (key && value) search.set(key, value);
    return { pathname: location.pathname, search: searchOf(search), hash };
  };
  const memoryTo =
    (pinned?.length ?? 0) + (memories?.length ?? 0) > 0 ? destination("#memory") : undefined;

  return (
    <div className="space-y-8" data-agent-operational-overview>
      <AgentHealthSection packageId={packageId} version={version} />

      <div className="grid gap-6 xl:grid-cols-3">
        <DetailSectionCard title={t("detail.overview.runs")} icon={PlayCircle} bodyClassName="p-0">
          <dl className="grid h-full divide-y">
            <OperationalStat
              size="sm"
              label={
                <span className="flex flex-wrap items-center gap-2">
                  {t("detail.overview.lastRun")}
                  {detail.last_run && <Badge status={detail.last_run.status} compact />}
                </span>
              }
              value={
                detail.last_run ? (
                  formatDateField(detail.last_run.started_at, "datetime")
                ) : (
                  <span className="text-muted-foreground">{t("detail.overview.noRuns")}</span>
                )
              }
              target={
                detail.last_run ? { to: runDetailPath(packageId, detail.last_run.id) } : undefined
              }
            />
            <OperationalStat
              size="sm"
              label={t("schedule.paramNextRun")}
              value={
                schedulesLoading ? (
                  <Skeleton className="h-5 w-32" />
                ) : nextSchedule?.next_run_at ? (
                  formatDateField(nextSchedule.next_run_at, "datetime", nextSchedule.timezone)
                ) : (
                  <span className="text-muted-foreground">
                    {schedulesError ? unknown : t("detail.overview.noSchedule")}
                  </span>
                )
              }
              target={
                nextSchedule?.next_run_at
                  ? { to: agentSettingsHref(location.pathname, "schedules") }
                  : undefined
              }
            />
          </dl>
        </DetailSectionCard>

        <DetailSectionCard
          title={`${t("detail.overview.activity")} · ${t("detail.overview.lastThirtyDays")}`}
          icon={ChartNoAxesCombined}
          bodyClassName="p-0"
          headerAction={
            activity && activity.total > 0
              ? { label: t("detail.overview.openRuns"), to: destination("#runs") }
              : undefined
          }
        >
          <dl className="grid h-full grid-cols-2 divide-x md:grid-cols-5 xl:grid-cols-2 xl:divide-x-0">
            <OperationalStat
              className="xl:border-border xl:border-r xl:border-b"
              label={t("detail.overview.totalRuns")}
              value={
                runActivity.isLoading
                  ? "…"
                  : runActivity.isError || !activity
                    ? unknown
                    : String(activity.total)
              }
              target={activity && activity.total > 0 ? { to: destination("#runs") } : undefined}
            />
            <OperationalStat
              className="xl:border-border xl:border-b"
              label={t("detail.overview.successRate")}
              value={
                runActivity.isLoading ? (
                  "…"
                ) : runActivity.isError || !activity ? (
                  unknown
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        tabIndex={0}
                        className="focus-visible:ring-ring cursor-help border-b border-dotted outline-none focus-visible:ring-2"
                      >
                        {successRateLabel}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{t("detail.overview.successRateHelp")}</TooltipContent>
                  </Tooltip>
                )
              }
            />
            <OperationalStat
              className="xl:border-border xl:border-r xl:border-b"
              label={t("detail.overview.failedRuns")}
              value={
                runActivity.isLoading
                  ? "…"
                  : runActivity.isError || failedRunCount === undefined
                    ? unknown
                    : String(failedRunCount)
              }
              target={
                failedRunCount && failedRunCount > 0
                  ? { to: destination("#runs", "agentRunStatus", "failed,timeout") }
                  : undefined
              }
            />
            <OperationalStat
              className="xl:border-border xl:border-b"
              label={t("detail.overview.runningRuns")}
              value={String(detail.running_runs)}
              target={
                detail.running_runs > 0
                  ? { to: destination("#runs", "agentRunStatus", "running") }
                  : undefined
              }
            />
            <OperationalStat
              className="xl:col-span-2"
              label={t("detail.overview.activeSchedules")}
              value={
                schedulesLoading ? (
                  <Skeleton className="h-6 w-10" />
                ) : schedulesError || !schedulesSuccess ? (
                  unknown
                ) : (
                  String(activeScheduleCount)
                )
              }
              target={
                activeScheduleCount && activeScheduleCount > 0
                  ? { to: agentSettingsHref(location.pathname, "schedules") }
                  : undefined
              }
            />
          </dl>
        </DetailSectionCard>

        <DetailSectionCard
          title={t("detail.overview.memoryActivity")}
          icon={Database}
          bodyClassName="p-0"
          headerAction={
            memoryTo ? { label: t("detail.overview.openMemory"), to: memoryTo } : undefined
          }
        >
          <dl className="grid h-full grid-cols-1 divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0 lg:grid-cols-1 lg:divide-x-0 lg:divide-y">
            <OperationalStat
              label={t("detail.overview.pinnedItems")}
              value={
                pinnedLoading ? (
                  <Skeleton className="h-6 w-10" />
                ) : pinnedError ? (
                  unknown
                ) : (
                  String(pinned?.length ?? 0)
                )
              }
              target={
                pinned && pinned.length > 0
                  ? { to: destination("#memory", "agentMemory", "pinned") }
                  : undefined
              }
            />
            <OperationalStat
              label={t("detail.overview.archivedItems")}
              value={
                memoriesLoading ? (
                  <Skeleton className="h-6 w-10" />
                ) : memoriesError ? (
                  unknown
                ) : (
                  String(memories?.length ?? 0)
                )
              }
              target={
                memories && memories.length > 0
                  ? { to: destination("#memory", "agentMemory", "archive") }
                  : undefined
              }
            />
            <OperationalStat
              label={t("detail.overview.lastUpdated")}
              value={
                pinnedLoading || memoriesLoading ? (
                  <Skeleton className="h-5 w-32" />
                ) : pinnedError || memoriesError ? (
                  unknown
                ) : latestMemory ? (
                  formatDateField(latestMemory, "datetime")
                ) : (
                  "—"
                )
              }
            />
          </dl>
        </DetailSectionCard>
      </div>
    </div>
  );
}
