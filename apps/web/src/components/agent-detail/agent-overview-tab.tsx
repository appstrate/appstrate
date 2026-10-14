// SPDX-License-Identifier: Apache-2.0

import { Link, useLocation, type To } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight, Brain, ChartNoAxesCombined, Database, PlayCircle } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import type { AgentDetail } from "@appstrate/shared-types";
import { useSchedules } from "../../hooks/use-schedules";
import { useAgentMemories, useAgentPinned } from "../../hooks/use-persistence";
import { Badge } from "../status-badge";
import { formatDateField } from "../../lib/format-date";
import { latestMemoryDate } from "../../lib/agent-overview";
import { runDetailPath } from "../../lib/package-paths";
import { agentSettingsHref } from "../../lib/settings-section-href";
import { searchOf } from "../../lib/url-search";
import { OperationalStat } from "../operational-stat";

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
  const unknown = t("detail.overview.unknown");
  const latestMemory = pinned && memories ? latestMemoryDate(pinned, memories) : undefined;

  const destination = (hash: string, key?: string, value?: string) => {
    const search = new URLSearchParams(location.search);
    if (hash === "#runs") search.delete("agentRunStatus");
    if (hash === "#memory") search.delete("agentMemory");
    if (key && value) search.set(key, value);
    return { pathname: location.pathname, search: searchOf(search), hash };
  };

  return (
    <div className="space-y-8" data-agent-operational-overview>
      <div className="grid gap-6 xl:grid-cols-3">
        <section
          className="border-border bg-muted/35 flex min-w-0 flex-col overflow-hidden rounded-lg border"
          aria-labelledby="agent-runs-heading"
        >
          <OverviewSectionHeading
            id="agent-runs-heading"
            icon={PlayCircle}
            title={t("detail.overview.runs")}
          />
          <div
            className={cn(
              "border-border bg-card grid h-full divide-y overflow-hidden rounded-lg border",
              "rounded-t-lg border-x-0 border-b-0",
            )}
          >
            <div className="flex min-w-0 flex-col">
              {detail.last_run ? (
                <Link
                  to={runDetailPath(packageId, detail.last_run.id)}
                  className="group hover:bg-muted/20 focus-visible:ring-ring relative flex min-w-0 flex-1 flex-col justify-center p-4 pr-10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-muted-foreground text-xs font-medium">
                        {t("detail.overview.lastRun")}
                      </p>
                      <Badge status={detail.last_run.status} compact />
                    </div>
                    <p className="text-foreground mt-3 text-sm">
                      {formatDateField(detail.last_run.started_at, "datetime")}
                    </p>
                  </div>
                  <ArrowRight className="text-muted-foreground/45 group-hover:text-primary group-focus-visible:text-primary absolute top-1/2 right-4 size-4 -translate-y-1/2 opacity-70 transition-all group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:translate-x-0.5 group-focus-visible:opacity-100" />
                </Link>
              ) : (
                <div className="p-4">
                  <p className="text-muted-foreground text-xs font-medium">
                    {t("detail.overview.lastRun")}
                  </p>
                  <p className="text-muted-foreground mt-3 text-sm">
                    {t("detail.overview.noRuns")}
                  </p>
                </div>
              )}
            </div>
            <div className="flex min-w-0 flex-col">
              {nextSchedule?.next_run_at ? (
                <Link
                  to={agentSettingsHref(location.pathname, "schedules")}
                  className="group hover:bg-muted/20 focus-visible:ring-ring relative flex min-w-0 flex-1 flex-col justify-center p-4 pr-10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset"
                >
                  <div className="min-w-0">
                    <p className="text-muted-foreground text-xs font-medium">
                      {t("schedule.paramNextRun")}
                    </p>
                    <p className="text-foreground mt-3 truncate text-sm">
                      {formatDateField(nextSchedule.next_run_at, "datetime", nextSchedule.timezone)}
                    </p>
                  </div>
                  <ArrowRight className="text-muted-foreground/45 group-hover:text-primary group-focus-visible:text-primary absolute top-1/2 right-4 size-4 -translate-y-1/2 opacity-70 transition-all group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:translate-x-0.5 group-focus-visible:opacity-100" />
                </Link>
              ) : (
                <div className="p-4">
                  <p className="text-muted-foreground text-xs font-medium">
                    {t("schedule.paramNextRun")}
                  </p>
                  {schedulesError ? (
                    <p className="text-muted-foreground mt-3 text-sm">{unknown}</p>
                  ) : (
                    <p className="text-muted-foreground mt-3 text-sm">
                      {t("detail.overview.noSchedule")}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

        <section
          className="border-border bg-muted/35 flex min-w-0 flex-col overflow-hidden rounded-lg border"
          aria-labelledby="agent-activity-heading"
        >
          <OverviewSectionHeading
            id="agent-activity-heading"
            icon={ChartNoAxesCombined}
            title={t("detail.overview.activity")}
          />
          <dl
            className={cn(
              "border-border bg-card grid h-full grid-cols-2 divide-x overflow-hidden rounded-lg border xl:grid-cols-1 xl:divide-x-0 xl:divide-y",
              "rounded-t-lg border-x-0 border-b-0",
            )}
          >
            <OperationalStat
              label={t("detail.overview.runningRuns")}
              value={String(detail.running_runs)}
              to={
                detail.running_runs > 0
                  ? destination("#runs", "agentRunStatus", "running")
                  : undefined
              }
            />
            <OperationalStat
              label={t("detail.overview.activeSchedules")}
              value={
                schedulesLoading
                  ? "…"
                  : schedulesError || !schedulesSuccess
                    ? unknown
                    : String(activeScheduleCount)
              }
              to={
                activeScheduleCount && activeScheduleCount > 0
                  ? agentSettingsHref(location.pathname, "schedules")
                  : undefined
              }
            />
          </dl>
        </section>

        <section
          className="border-border bg-muted/35 flex min-w-0 flex-col overflow-hidden rounded-lg border"
          aria-labelledby="agent-memory-heading"
        >
          <OverviewSectionHeading
            id="agent-memory-heading"
            icon={Database}
            title={t("detail.overview.memoryActivity")}
            to={
              (pinned?.length ?? 0) + (memories?.length ?? 0) > 0
                ? destination("#memory")
                : undefined
            }
            actionLabel={t("detail.overview.openMemory")}
          />
          <dl
            className={cn(
              "border-border bg-card grid h-full grid-cols-1 divide-y overflow-hidden rounded-lg border sm:grid-cols-3 sm:divide-x sm:divide-y-0 lg:grid-cols-1 lg:divide-x-0 lg:divide-y",
              "rounded-t-lg border-x-0 border-b-0",
            )}
          >
            <OperationalStat
              label={t("detail.overview.pinnedItems")}
              value={pinnedLoading ? "…" : pinnedError ? unknown : String(pinned?.length ?? 0)}
              to={
                pinned && pinned.length > 0
                  ? destination("#memory", "agentMemory", "pinned")
                  : undefined
              }
            />
            <OperationalStat
              label={t("detail.overview.archivedItems")}
              value={
                memoriesLoading ? "…" : memoriesError ? unknown : String(memories?.length ?? 0)
              }
              to={
                memories && memories.length > 0
                  ? destination("#memory", "agentMemory", "archive")
                  : undefined
              }
            />
            <OperationalStat
              label={t("detail.overview.lastUpdated")}
              value={
                pinnedLoading || memoriesLoading
                  ? "…"
                  : pinnedError || memoriesError
                    ? unknown
                    : latestMemory
                      ? formatDateField(latestMemory, "datetime")
                      : "—"
              }
            />
          </dl>
        </section>
      </div>
    </div>
  );
}

function OverviewSectionHeading({
  id,
  icon: Icon,
  title,
  to,
  actionLabel,
}: {
  id: string;
  icon: typeof Brain;
  title: string;
  to?: To;
  actionLabel?: string;
}) {
  const content = (
    <>
      <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <h2 id={id} className="text-sm font-semibold">
        {title}
      </h2>
      {to && (
        <ArrowRight className="text-muted-foreground group-hover:text-primary group-focus-visible:text-primary ml-auto size-4 shrink-0 transition-all group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5" />
      )}
    </>
  );

  if (to) {
    return (
      <Link
        to={to}
        aria-label={actionLabel}
        title={actionLabel}
        className={cn(
          "group focus-visible:ring-ring flex min-h-5 items-center gap-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset",
          "bg-muted/35 hover:bg-muted px-4 py-3",
        )}
      >
        {content}
      </Link>
    );
  }

  return <div className="bg-muted/35 flex min-h-5 items-center gap-2 px-4 py-3">{content}</div>;
}
