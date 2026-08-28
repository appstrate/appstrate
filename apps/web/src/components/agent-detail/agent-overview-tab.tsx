// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Link, useLocation, type To } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Activity,
  ArrowRight,
  Brain,
  CalendarClock,
  ChartNoAxesCombined,
  CircleX,
  Cpu,
  Database,
  FileInput,
  FileOutput,
  Globe,
  Plug,
  PlayCircle,
  Puzzle,
  Server,
  SlidersHorizontal,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { Badge as StatusPill } from "@appstrate/ui/components/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";
import type { AgentDetail } from "@appstrate/shared-types";
import { useAgentReadiness } from "../../hooks/use-agent-readiness";
import { useAgentConnectionReadiness } from "../../hooks/use-integrations";
import { useModels, useAgentModel } from "../../hooks/use-models";
import { useProxies, useAgentProxy } from "../../hooks/use-proxies";
import { useSchedules } from "../../hooks/use-schedules";
import { useAgentRunActivity } from "../../hooks/use-paginated-runs";
import { useAgentMemories, useAgentPinned } from "../../hooks/use-persistence";
import { Badge } from "../status-badge";
import { formatDateField } from "../../lib/markdown";
import { AgentMapView } from "../../modules/agent-map/agent-map-view";
import { AgentFilesView } from "./agent-files-view";
import { useAgentDiagnostics } from "../../hooks/use-agent-diagnostics";
import { AgentDiagnosticsDialog, AgentDiagnosticsIssueBadge } from "./agent-diagnostics-dialog";
import {
  agentDiagnosticCorrectionTarget,
  agentDiagnosticLocateTarget,
} from "../../lib/agent-diagnostics";
import { OverviewCardAction } from "../overview-card-action";

function AgentHealthSection({
  packageId,
  version,
  cardHeaders = false,
}: {
  packageId: string;
  version?: string;
  cardHeaders?: boolean;
}) {
  const { t } = useTranslation("agents");
  const location = useLocation();
  const diagnostics = useAgentDiagnostics(packageId, version);
  const result = diagnostics.data;
  const [issuesOpen, setIssuesOpen] = useState(false);

  if (diagnostics.isLoading) {
    return (
      <section
        className={cn(
          "border-border rounded-lg border",
          cardHeaders && "bg-muted/35",
          cardHeaders ? "overflow-hidden" : "p-4",
        )}
        aria-label={t("detail.diagnostics.sectionTitle")}
        aria-busy="true"
      >
        <div
          className={cn(
            "flex flex-wrap items-center gap-2",
            cardHeaders && "bg-muted/35 px-4 py-3",
          )}
        >
          <span className="bg-muted size-4 animate-pulse rounded" />
          <span className="bg-muted h-4 w-28 animate-pulse rounded" />
          <span className="bg-muted h-5 w-32 animate-pulse rounded-md" />
        </div>
      </section>
    );
  }

  if (result?.status === "healthy") return null;

  const visible = result?.diagnostics.slice(0, 3) ?? [];
  const isUnknown = diagnostics.isError || !result;
  const tone = isUnknown ? "unknown" : result.status;
  const Icon = tone === "blocking" ? CircleX : tone === "warning" ? TriangleAlert : Activity;
  const title = isUnknown
    ? t("detail.diagnostics.unknownTitle")
    : result.status === "blocking"
      ? t("detail.diagnostics.blockingTitle", { count: result.blocking_count })
      : t("detail.diagnostics.warningTitle", { count: result.warning_count });
  return (
    <>
      <section
        aria-labelledby="agent-health-heading"
        className={cn(
          "border-border rounded-lg border",
          cardHeaders ? "bg-muted/35 overflow-hidden" : "bg-card p-4",
          tone === "blocking" && "border-destructive/30",
          tone === "warning" && "border-warning/30",
        )}
      >
        <div
          className={cn(
            "flex flex-wrap items-center gap-2",
            cardHeaders && "bg-muted/35 px-4 py-3",
          )}
        >
          <Icon
            className={cn(
              "size-4 shrink-0",
              tone === "blocking"
                ? "text-destructive"
                : tone === "warning"
                  ? "text-warning"
                  : "text-muted-foreground",
            )}
            aria-hidden
          />
          <h2 id="agent-health-heading" className="text-sm font-semibold">
            {t("detail.diagnostics.sectionTitle")}
          </h2>
          {result ? (
            <button type="button" onClick={() => setIssuesOpen(true)}>
              <AgentDiagnosticsIssueBadge result={result} />
            </button>
          ) : (
            <StatusPill variant="pending">{title}</StatusPill>
          )}
        </div>
        <div className={cn(cardHeaders && "bg-card overflow-hidden rounded-t-lg border-t")}>
          <div className={cn(cardHeaders && "px-4")}>
            {result?.status === "blocking" && result.warning_count > 0 && (
              <p className="text-muted-foreground pt-4 text-xs">
                {t("detail.diagnostics.warningAlongside", { count: result.warning_count })}
              </p>
            )}

            {visible.length > 0 && (
              <ul
                className={cn(
                  "divide-y",
                  !cardHeaders && "mt-3",
                  cardHeaders &&
                    result?.status === "blocking" &&
                    result.warning_count > 0 &&
                    "mt-3",
                )}
              >
                {visible.map((diagnostic) => (
                  <li
                    key={`${diagnostic.code}:${diagnostic.field}`}
                    className={cn(
                      "grid gap-2 py-4 sm:grid-cols-[minmax(0,1fr)_auto]",
                      cardHeaders ? "first:pt-4 last:pb-4" : "first:pt-0 last:pb-0",
                    )}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{diagnostic.title}</p>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {diagnostic.explanation}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 text-xs sm:self-center">
                      <Link
                        to={agentDiagnosticCorrectionTarget(
                          diagnostic,
                          location.pathname,
                          location.search,
                        )}
                        className="text-primary hover:underline"
                      >
                        {t("detail.diagnostics.fix")}
                      </Link>
                      <Link
                        to={agentDiagnosticLocateTarget(
                          diagnostic,
                          location.pathname,
                          location.search,
                        )}
                        className="text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {t("detail.diagnostics.locate")}
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {result && result.diagnostics.length > 3 && !cardHeaders && (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => setIssuesOpen(true)}
                  className="text-primary text-xs font-medium hover:underline"
                >
                  {t("detail.diagnostics.seeAll")}
                </button>
              </div>
            )}
          </div>
          {result && result.diagnostics.length > 3 && cardHeaders && (
            <OverviewCardAction onClick={() => setIssuesOpen(true)}>
              {t("detail.diagnostics.seeAll")}
            </OverviewCardAction>
          )}
        </div>
      </section>
      <AgentDiagnosticsDialog
        result={result}
        open={issuesOpen}
        onClose={() => setIssuesOpen(false)}
      />
    </>
  );
}

function MapNode({
  icon: Icon,
  label,
  value,
  href,
  onClick,
  tone = "default",
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  href?: string;
  onClick?: () => void;
  tone?: "default" | "warning";
}) {
  const body = (
    <div
      className={cn(
        "bg-background flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2.5 text-left shadow-sm",
        tone === "warning" && "border-warning/50 bg-warning/5",
        href && "hover:border-foreground/25 transition-colors",
      )}
    >
      <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0">
        <span className="text-muted-foreground block text-[10px] font-semibold tracking-wide uppercase">
          {label}
        </span>
        <span className="mt-0.5 block truncate text-xs font-medium">{value}</span>
      </span>
    </div>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="w-full">
        {body}
      </button>
    );
  }
  return href ? <Link to={{ hash: href }}>{body}</Link> : body;
}

function Boundary({
  label,
  description,
  className,
  children,
}: {
  label: string;
  description: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("bg-muted/25 rounded-xl border border-dashed p-3", className)}>
      <div className="mb-3">
        <h3 className="text-xs font-semibold tracking-wide uppercase">{label}</h3>
        <p className="text-muted-foreground mt-0.5 text-[11px]">{description}</p>
      </div>
      {children}
    </section>
  );
}

function RelationLegend() {
  const { t } = useTranslation("agents");
  return (
    <div className="text-muted-foreground flex w-max min-w-full items-center gap-5 text-[11px] whitespace-nowrap">
      <span className="inline-flex items-center gap-2">
        <span className="bg-foreground h-px w-6" />
        {t("detail.overview.relationFlow")}
      </span>
      <span className="inline-flex items-center gap-2">
        <span className="border-foreground/60 w-6 border-t" />
        {t("detail.overview.relationDependency")}
      </span>
      <span className="inline-flex items-center gap-2">
        <span className="border-foreground/60 w-6 border-t border-dashed" />
        {t("detail.overview.relationResolution")}
      </span>
    </div>
  );
}

export function AgentOverviewTab({
  packageId,
  detail,
  version,
  isHistorical = false,
  currentManifest,
  currentContent,
  surface,
  onOpenFiles,
  cardHeaders = false,
  contained = false,
}: {
  packageId: string;
  detail: AgentDetail;
  version?: string | undefined;
  isHistorical?: boolean | undefined;
  currentManifest?: Record<string, unknown> | undefined;
  currentContent?: string | null | undefined;
  surface: "summary" | "map" | "files";
  onOpenFiles: () => void;
  cardHeaders?: boolean;
  contained?: boolean;
}) {
  const { t, i18n } = useTranslation("agents");
  const location = useLocation();
  const { data: models } = useModels();
  const { data: agentModel } = useAgentModel(packageId);
  const { data: proxies } = useProxies();
  const { data: agentProxy } = useAgentProxy(packageId);
  const {
    data: schedules,
    isLoading: schedulesLoading,
    isError: schedulesError,
    isSuccess: schedulesSuccess,
  } = useSchedules(packageId);
  const runActivity = useAgentRunActivity(packageId);
  const { data: connections, isError: connectionsError } = useAgentConnectionReadiness(packageId);
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
  const readiness = useAgentReadiness(detail, agentModel?.modelId, models, detail.input?.schema);

  const defaultModel = models?.find((model) => model.is_default);
  const resolvedModel = models?.find((model) => model.id === agentModel?.modelId) ?? defaultModel;
  const defaultProxy = proxies?.find((proxy) => proxy.is_default && proxy.enabled);
  const resolvedProxy = proxies?.find((proxy) => proxy.id === agentProxy?.proxyId) ?? defaultProxy;
  const inputProperties = detail.input?.schema?.properties ?? {};
  const inputCount = Object.keys(inputProperties).length;
  const configuredCount = Object.keys(detail.config.current ?? {}).length;
  const connectionRows = connections?.integrations ?? [];
  const nextSchedule = schedules?.find((schedule) => schedule.enabled && schedule.next_run_at);
  const activeScheduleCount = schedules?.filter((schedule) => schedule.enabled).length;
  const connectionCount = connectionRows.filter(
    (row) => row.resolution?.resolved_connection_id,
  ).length;
  const connectionsKnown =
    detail.dependencies.integrations.length === 0 || (!!connections && !connectionsError);
  const unknown = t("detail.overview.unknown");
  const configNodes = [
    {
      icon: CalendarClock,
      label: t("detail.overview.schedules"),
      value:
        schedules && !schedulesError
          ? t("detail.overview.itemCount", { count: schedules.length })
          : unknown,
    },
    { icon: Cpu, label: t("detail.overview.model"), value: resolvedModel?.label ?? unknown },
    {
      icon: SlidersHorizontal,
      label: t("detail.overview.inputValues"),
      value: t("detail.overview.configuredInputs", {
        configured: configuredCount,
        total: inputCount,
      }),
    },
    { icon: Globe, label: t("detail.overview.proxy"), value: resolvedProxy?.label ?? unknown },
    {
      icon: Plug,
      label: t("detail.overview.connections"),
      value:
        connections && !connectionsError
          ? t("detail.overview.itemCount", { count: connectionCount })
          : unknown,
    },
  ];
  const dependencyNodes = [
    {
      icon: Puzzle,
      label: t("detail.overview.integrations"),
      value: t("detail.overview.itemCount", { count: detail.dependencies.integrations.length }),
    },
    {
      icon: Brain,
      label: t("detail.overview.skills"),
      value: t("detail.overview.itemCount", { count: detail.dependencies.skills.length }),
    },
    {
      icon: Server,
      label: t("detail.overview.mcpServers"),
      value: t("detail.overview.itemCount", { count: detail.dependencies.mcp_servers.length }),
    },
    {
      icon: Wrench,
      label: t("detail.overview.systemTools"),
      value: Array.isArray(detail.manifest?.runtime_tools)
        ? t("detail.overview.itemCount", { count: detail.manifest.runtime_tools.length })
        : unknown,
    },
  ];
  const memoryDates = [
    ...(pinned ?? []).flatMap((item) => [item.updatedAt, item.createdAt]),
    ...(memories ?? []).map((item) => item.createdAt),
  ].filter((date): date is string => Boolean(date));
  const latestMemoryDate =
    pinnedSuccess && memoriesSuccess
      ? memoryDates.sort((a, b) => Date.parse(b) - Date.parse(a))[0]
      : undefined;
  const configurationWarning = t("detail.overview.configurationRequiredDescription");
  const settingsHref = (section: "model" | "proxy" | "inputs" | "connections" | "schedules") => {
    const search = new URLSearchParams(location.search);
    if (section === "model") search.delete("agentSettings");
    else search.set("agentSettings", section);
    const query = search.toString();
    return `${location.pathname}${query ? `?${query}` : ""}#settings`;
  };
  const installedMap = {
    configuration: {
      schedules: {
        id: "schedule",
        title: t("detail.overview.schedules"),
        value:
          schedules && !schedulesError
            ? t("detail.overview.itemCount", { count: schedules.length })
            : unknown,
        description: nextSchedule?.next_run_at
          ? formatDateField(nextSchedule.next_run_at, "datetime")
          : t("detail.overview.noSchedule"),
        icon: "schedule",
        href: nextSchedule ? `/schedules/${nextSchedule.id}` : settingsHref("schedules"),
      },
      model: {
        id: "model",
        title: t("detail.overview.model"),
        value: resolvedModel?.label ?? unknown,
        icon: "model",
        href: settingsHref("model"),
        warning: readiness.hasModel ? undefined : configurationWarning,
      },
      inputValues: {
        id: "input-values",
        title: t("detail.overview.inputValues"),
        value: t("detail.overview.configuredInputs", {
          configured: configuredCount,
          total: inputCount,
        }),
        icon: "values",
        href: settingsHref("inputs"),
        warning: readiness.hasRequiredConfig ? undefined : configurationWarning,
      },
      proxy: {
        id: "proxy",
        title: t("detail.overview.proxy"),
        value: resolvedProxy?.label ?? unknown,
        icon: "proxy",
        href: settingsHref("proxy"),
      },
      connections: {
        id: "connections",
        title: t("detail.overview.connections"),
        value:
          connections && !connectionsError
            ? t("detail.overview.itemCount", { count: connectionCount })
            : unknown,
        icon: "connection",
        href: settingsHref("connections"),
        warning: connectionsKnown && !connections?.blocks_run ? undefined : configurationWarning,
      },
    },
    bundle: {
      input: {
        id: "input-schema",
        title: t("detail.overview.inputSchema"),
        value: t("detail.overview.fieldCount", { count: inputCount }),
        icon: "input",
        onActivate: onOpenFiles,
      },
      agent: {
        id: "agent",
        title: t("detail.overview.agent"),
        value: detail.display_name ?? detail.id,
        description: detail.prompt ?? undefined,
        icon: "agent",
        onActivate: onOpenFiles,
        warning: readiness.hasPrompt ? undefined : configurationWarning,
      },
      output: {
        id: "output-schema",
        title: t("detail.overview.outputSchema"),
        value: detail.output?.schema ? t("detail.overview.declared") : unknown,
        icon: "output",
        onActivate: onOpenFiles,
      },
      integrations: {
        id: "integrations",
        title: t("detail.overview.integrations"),
        value: t("detail.overview.itemCount", {
          count: detail.dependencies.integrations.length,
        }),
        icon: "integration",
        onActivate: onOpenFiles,
      },
      skills: {
        id: "skills",
        title: t("detail.overview.skills"),
        value: t("detail.overview.itemCount", { count: detail.dependencies.skills.length }),
        icon: "skill",
        onActivate: onOpenFiles,
        warning: readiness.hasRequiredSkills ? undefined : configurationWarning,
      },
      mcpServers: {
        id: "mcp-servers",
        title: t("detail.overview.mcpServers"),
        value: t("detail.overview.itemCount", {
          count: detail.dependencies.mcp_servers.length,
        }),
        icon: "mcp",
        onActivate: onOpenFiles,
      },
      systemTools: {
        id: "system-tools",
        title: t("detail.overview.systemTools"),
        value: Array.isArray(detail.manifest?.runtime_tools)
          ? t("detail.overview.itemCount", { count: detail.manifest.runtime_tools.length })
          : unknown,
        icon: "tools",
        onActivate: onOpenFiles,
      },
    },
    memory: {
      id: "memory",
      title: t("detail.overview.appstrateMemory"),
      value: [
        pinned && !pinnedError
          ? t("detail.overview.pins", { count: pinned.length })
          : t("detail.overview.pinsUnknown"),
        memories && !memoriesError
          ? t("detail.overview.notes", { count: memories.length })
          : t("detail.overview.notesUnknown"),
      ].join(" · "),
      description: latestMemoryDate
        ? t("detail.overview.lastMemoryUpdate", {
            date: formatDateField(latestMemoryDate, "datetime"),
          })
        : undefined,
      icon: "memory",
      href: "#memory",
    },
    scheduleActive: Boolean(nextSchedule?.next_run_at),
  };
  // The structured mobile map below still derives from the same local facts.
  // Keep this projection alive until it is moved behind the shared map DTO.
  void installedMap;

  if (surface === "files") {
    return (
      <AgentFilesView
        packageId={packageId}
        initialVersion={version}
        currentManifest={currentManifest}
        currentContent={currentContent}
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

  if (surface === "summary") {
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
      <TooltipProvider>
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
      </TooltipProvider>
    );
  }

  return (
    <div className="px-4 py-4 md:px-6 md:py-6" data-agent-overview>
      <div className="hidden md:block">
        <AgentMapView packageId={packageId} version={version} />
      </div>

      <section
        className="bg-background space-y-3 rounded-xl border p-3 md:hidden"
        data-agent-map-mobile
      >
        <div className="space-y-3">
          <Boundary
            label={t("detail.overview.appstrateConfiguration")}
            description={t("detail.overview.appstrateConfigurationDescription")}
          >
            <div className="space-y-2">
              {configNodes.map((node) => (
                <MapNode key={node.label} {...node} href={settingsHref("inputs")} />
              ))}
            </div>
          </Boundary>
          <Boundary
            label={t("detail.overview.portableBundle")}
            description={t("detail.overview.portableBundleDescription")}
          >
            <div className="space-y-2">
              <MapNode
                icon={FileInput}
                label={t("detail.overview.inputSchema")}
                value={t("detail.overview.fieldCount", { count: inputCount })}
                onClick={onOpenFiles}
              />
              <p className="text-muted-foreground pl-3 text-[11px]">
                ↓ {t("detail.overview.feeds")}
              </p>
              <MapNode
                icon={Cpu}
                label={t("detail.overview.agent")}
                value={detail.display_name ?? detail.id}
                onClick={onOpenFiles}
              />
              <p className="text-muted-foreground pl-3 text-[11px]">
                ↓ {t("detail.overview.produces")}
              </p>
              <MapNode
                icon={FileOutput}
                label={t("detail.overview.outputSchema")}
                value={detail.output?.schema ? t("detail.overview.declared") : unknown}
                onClick={onOpenFiles}
              />
              <div className="space-y-2 pt-2">
                {dependencyNodes.map((node) => (
                  <MapNode key={node.label} {...node} onClick={onOpenFiles} />
                ))}
              </div>
            </div>
          </Boundary>
        </div>
        <Boundary
          label={t("detail.overview.appstrateMemory")}
          description={t("detail.overview.appstrateMemoryDescription")}
        >
          <Link
            to={{ hash: "#memory" }}
            className="bg-background hover:border-foreground/25 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border px-3 py-3 text-sm transition-colors"
          >
            <span className="inline-flex items-center gap-2">
              <Database className="text-muted-foreground size-4" />
              {pinned && !pinnedError
                ? t("detail.overview.pins", { count: pinned.length })
                : t("detail.overview.pinsUnknown")}
            </span>
            <span>
              {memories && !memoriesError
                ? t("detail.overview.notes", { count: memories.length })
                : t("detail.overview.notesUnknown")}
            </span>
            <span className="text-muted-foreground ml-auto text-xs">
              {t("detail.overview.openMemory")}
            </span>
          </Link>
        </Boundary>
        <RelationLegend />
      </section>
    </div>
  );
}

function OperationalStat({
  label,
  value,
  to,
  className,
}: {
  label: string;
  value: React.ReactNode;
  to?: To;
  className?: string;
}) {
  const content = (
    <>
      <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
    </>
  );

  return (
    <div className={cn("min-w-0", className)}>
      {to ? (
        <Link
          className="group hover:bg-muted/20 focus-visible:ring-ring relative flex h-full min-h-20 flex-col justify-center px-4 py-4 pr-10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset"
          to={to}
        >
          {content}
          <ArrowRight className="text-muted-foreground/45 group-hover:text-primary group-focus-visible:text-primary absolute top-1/2 right-4 size-4 -translate-y-1/2 opacity-70 transition-all group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:translate-x-0.5 group-focus-visible:opacity-100" />
        </Link>
      ) : (
        <div className="flex h-full min-h-20 flex-col justify-center px-4 py-4">{content}</div>
      )}
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
