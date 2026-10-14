// SPDX-License-Identifier: Apache-2.0

import { Link, useLocation, type To } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight, Brain, ChartNoAxesCombined, Database, PlayCircle } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import type { AgentDetail } from "@appstrate/shared-types";
import { useSchedules } from "../../hooks/use-schedules";
import { useAgentRunActivity } from "../../hooks/use-paginated-runs";
import { useAgentMemories, useAgentPinned } from "../../hooks/use-persistence";
import { Badge } from "../status-badge";
import { formatDateField } from "../../lib/format-date";
import { PackageFilesView } from "../package-files/package-files-view";
import { OperationalStat } from "../operational-stat";
import { AgentHealthSection } from "./agent-health-section";

export function AgentOverviewTab({
  packageId,
  detail,
  version,
  isHistorical = false,
  currentManifest,
  currentContent,
  surface,
  cardHeaders = false,
  contained = false,
  fileEditHref,
  initialFilePath,
  canEditFiles = false,
}: {
  packageId: string;
  detail: AgentDetail;
  version?: string | undefined;
  isHistorical?: boolean | undefined;
  currentManifest?: Record<string, unknown> | undefined;
  currentContent?: string | null | undefined;
  surface: "summary" | "files";
  cardHeaders?: boolean;
  contained?: boolean;
  fileEditHref?: (path: string) => string | undefined;
  /** Explorer › Fichiers opened on this bundle file, when a link sent the reader to it. */
  initialFilePath?: string;
  /** The reader may change the draft's files in Explorer › Fichiers. */
  canEditFiles?: boolean;
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
    isSuccess: memoriesSuccess,
  } = useAgentMemories(packageId);
  const {
    data: pinned,
    isLoading: pinnedLoading,
    isError: pinnedError,
    isSuccess: pinnedSuccess,
  } = useAgentPinned(packageId);
  const nextSchedule = schedules?.find((schedule) => schedule.enabled && schedule.next_run_at);
  const activeScheduleCount = schedules?.filter((schedule) => schedule.enabled).length;
  const unknown = t("detail.overview.unknown");
  const memoryDates = [
    ...(pinned ?? []).flatMap((item) => [item.updatedAt, item.createdAt]),
    ...(memories ?? []).map((item) => item.createdAt),
  ].filter((date): date is string => Boolean(date));
  const latestMemoryDate =
    pinnedSuccess && memoriesSuccess
      ? memoryDates.sort((a, b) => Date.parse(b) - Date.parse(a))[0]
      : undefined;
  const settingsHref = (section: "model" | "proxy" | "inputs" | "connections" | "schedules") => {
    const search = new URLSearchParams(location.search);
    if (section === "model") search.delete("agentSettings");
    else search.set("agentSettings", section);
    const query = search.toString();
    return `${location.pathname}${query ? `?${query}` : ""}#settings`;
  };

  if (surface === "files") {
    return (
      <PackageFilesView
        type="agent"
        packageId={packageId}
        initialVersion={version}
        currentManifest={currentManifest}
        currentContent={currentContent}
        editHref={fileEditHref}
        initialPath={initialFilePath}
        editable={canEditFiles}
      />
    );
  }

  if (isHistorical) {
    return (
      <div className="p-3">
        <p className="text-muted-foreground rounded-lg border p-4 text-sm">
          {t("detail.overview.historicalUnavailable")}
        </p>
      </div>
    );
  }

  const activity = runActivity.data;
  const failedRunCount = activity ? activity.failed + activity.timeout : undefined;
  const successRateDenominator = activity
    ? activity.success + activity.failed + activity.timeout
    : undefined;
  const successRate =
    successRateDenominator && successRateDenominator > 0
      ? activity!.success / successRateDenominator
      : null;
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
    const query = search.toString();
    return { pathname: location.pathname, search: query ? `?${query}` : "", hash };
  };

  return (
    <div
      className={cn(
        "space-y-8",
        !contained && "pt-8 pb-4 md:pb-6",
        !cardHeaders && !contained && "px-4 md:px-6",
      )}
      data-agent-operational-overview
    >
      <AgentHealthSection packageId={packageId} version={version} cardHeaders={cardHeaders} />

      <div className="grid gap-6 xl:grid-cols-3">
        <section
          className={cn(
            "flex min-w-0 flex-col",
            cardHeaders && "border-border bg-muted/35 overflow-hidden rounded-lg border",
          )}
          aria-labelledby="agent-executions-heading"
        >
          <OverviewSectionHeading
            id="agent-executions-heading"
            icon={PlayCircle}
            title={t("detail.overview.executions")}
            embedded={cardHeaders}
          />
          <div
            className={cn(
              "border-border bg-card grid h-full divide-y overflow-hidden rounded-lg border",
              cardHeaders && "rounded-t-lg border-x-0 border-b-0",
            )}
          >
            <div className="flex min-w-0 flex-col">
              {detail.last_run ? (
                <Link
                  to={`/agents/${packageId}/runs/${detail.last_run.id}`}
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
                  to={settingsHref("schedules")}
                  className="group hover:bg-muted/20 focus-visible:ring-ring relative flex min-w-0 flex-1 flex-col justify-center p-4 pr-10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset"
                >
                  <div className="min-w-0">
                    <p className="text-muted-foreground text-xs font-medium">
                      {t("detail.overview.nextExecution")}
                    </p>
                    <p className="text-foreground mt-3 truncate text-sm">
                      {formatDateField(nextSchedule.next_run_at, "datetime")}
                    </p>
                  </div>
                  <ArrowRight className="text-muted-foreground/45 group-hover:text-primary group-focus-visible:text-primary absolute top-1/2 right-4 size-4 -translate-y-1/2 opacity-70 transition-all group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:translate-x-0.5 group-focus-visible:opacity-100" />
                </Link>
              ) : (
                <div className="p-4">
                  <p className="text-muted-foreground text-xs font-medium">
                    {t("detail.overview.nextExecution")}
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
          className={cn(
            "flex min-w-0 flex-col",
            cardHeaders && "border-border bg-muted/35 overflow-hidden rounded-lg border",
          )}
          aria-labelledby="agent-activity-heading"
        >
          <OverviewSectionHeading
            id="agent-activity-heading"
            icon={ChartNoAxesCombined}
            title={t("detail.overview.activity")}
            embedded={cardHeaders}
            trailing={
              <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px] font-medium">
                {t("detail.overview.lastThirtyDays")}
              </span>
            }
            to={activity && activity.total > 0 ? destination("#runs") : undefined}
            actionLabel={t("detail.overview.openRuns")}
          />
          <dl
            className={cn(
              "border-border bg-card grid h-full grid-cols-2 divide-x overflow-hidden rounded-lg border md:grid-cols-5 xl:grid-cols-2 xl:divide-x-0",
              cardHeaders && "rounded-t-lg border-x-0 border-b-0",
            )}
          >
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
              to={activity && activity.total > 0 ? destination("#runs") : undefined}
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
              to={
                failedRunCount && failedRunCount > 0
                  ? destination("#runs", "agentRunStatus", "failed,timeout")
                  : undefined
              }
            />
            <OperationalStat
              className="xl:border-border xl:border-b"
              label={t("detail.overview.runningRuns")}
              value={String(detail.running_runs)}
              to={
                detail.running_runs > 0
                  ? destination("#runs", "agentRunStatus", "running")
                  : undefined
              }
            />
            <OperationalStat
              className="xl:col-span-2"
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
                  ? settingsHref("schedules")
                  : undefined
              }
            />
          </dl>
        </section>

        <section
          className={cn(
            "flex min-w-0 flex-col",
            cardHeaders && "border-border bg-muted/35 overflow-hidden rounded-lg border",
          )}
          aria-labelledby="agent-memory-heading"
        >
          <OverviewSectionHeading
            id="agent-memory-heading"
            icon={Database}
            title={t("detail.overview.memoryActivity")}
            embedded={cardHeaders}
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
              cardHeaders && "rounded-t-lg border-x-0 border-b-0",
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
                    : latestMemoryDate
                      ? formatDateField(latestMemoryDate, "datetime")
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
  trailing,
  to,
  actionLabel,
  embedded = false,
}: {
  id: string;
  icon: typeof Brain;
  title: string;
  trailing?: React.ReactNode;
  to?: To;
  actionLabel?: string;
  embedded?: boolean;
}) {
  const content = (
    <>
      <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <h2 id={id} className="text-sm font-semibold">
        {title}
      </h2>
      {trailing}
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
          embedded ? "bg-muted/35 hover:bg-muted px-4 py-3" : "hover:bg-muted/40 mb-2 rounded-sm",
        )}
      >
        {content}
      </Link>
    );
  }

  return (
    <div
      className={cn("flex min-h-5 items-center gap-2", embedded ? "bg-muted/35 px-4 py-3" : "mb-2")}
    >
      {content}
    </div>
  );
}
