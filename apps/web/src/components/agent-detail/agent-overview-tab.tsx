// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChartNoAxesCombined, Database, PlayCircle } from "lucide-react";
import type { AgentDetail } from "@appstrate/shared-types";
import { useSchedules } from "../../hooks/use-schedules";
import { useAgentMemories, useAgentPinned } from "../../hooks/use-persistence";
import { RunStatusBadge } from "../status-badge";
import { formatDateField } from "../../lib/format-date";
import { latestMemoryDate } from "../../lib/agent-overview";
import { runDetailPath } from "../../lib/package-paths";
import { agentSettingsHref } from "../../lib/settings-section-href";
import { searchOf } from "../../lib/url-search";
import { OperationalStat } from "../operational-stat";
import { DetailSectionCard } from "../detail-section-card";
import { Skeleton } from "@appstrate/ui/components/skeleton";

/** A figure read from a query: a placeholder while it loads, « unknown » when the read failed. */
function QueryValue({
  loading,
  error,
  skeleton = "h-6 w-10",
  children,
}: {
  loading: boolean;
  error: boolean;
  skeleton?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation("agents");
  if (loading) return <Skeleton className={skeleton} />;
  return error ? t("detail.overview.unknown") : children;
}

export function AgentOverviewTab({
  packageId,
  detail,
  isHistorical,
}: {
  packageId: string;
  detail: AgentDetail;
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
  return <OperationalSummary packageId={packageId} detail={detail} />;
}

/** The live counters, read only where they are shown. */
function OperationalSummary({ packageId, detail }: { packageId: string; detail: AgentDetail }) {
  const { t } = useTranslation("agents");
  const location = useLocation();
  const {
    data: schedules,
    isLoading: schedulesLoading,
    isError: schedulesError,
    isSuccess: schedulesSuccess,
  } = useSchedules(packageId);
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
  const latestMemory = pinned && memories ? latestMemoryDate(pinned, memories) : undefined;

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
    <div className="flex flex-col gap-8" data-agent-operational-overview>
      <div className="grid gap-6 xl:grid-cols-3">
        <DetailSectionCard title={t("detail.overview.runs")} icon={PlayCircle} bodyClassName="p-0">
          <dl className="grid h-full divide-y">
            <OperationalStat
              size="sm"
              label={
                <span className="flex flex-wrap items-center gap-2">
                  {t("detail.overview.lastRun")}
                  {detail.last_run && <RunStatusBadge status={detail.last_run.status} compact />}
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
                    {t(schedulesError ? "detail.overview.unknown" : "detail.overview.noSchedule")}
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
          title={t("detail.overview.activity")}
          icon={ChartNoAxesCombined}
          bodyClassName="p-0"
        >
          <dl className="grid h-full grid-cols-2 divide-x xl:grid-cols-1 xl:divide-x-0 xl:divide-y">
            <OperationalStat
              label={t("detail.overview.runningRuns")}
              value={String(detail.running_runs)}
              target={
                detail.running_runs > 0
                  ? { to: destination("#runs", "agentRunStatus", "running") }
                  : undefined
              }
            />
            <OperationalStat
              label={t("detail.overview.activeSchedules")}
              value={
                <QueryValue loading={schedulesLoading} error={schedulesError || !schedulesSuccess}>
                  {String(activeScheduleCount)}
                </QueryValue>
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
                <QueryValue loading={pinnedLoading} error={pinnedError}>
                  {String(pinned?.length ?? 0)}
                </QueryValue>
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
                <QueryValue loading={memoriesLoading} error={memoriesError}>
                  {String(memories?.length ?? 0)}
                </QueryValue>
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
                <QueryValue
                  loading={pinnedLoading || memoriesLoading}
                  error={pinnedError || memoriesError}
                  skeleton="h-5 w-32"
                >
                  {latestMemory ? formatDateField(latestMemory, "datetime") : "—"}
                </QueryValue>
              }
            />
          </dl>
        </DetailSectionCard>
      </div>
    </div>
  );
}
