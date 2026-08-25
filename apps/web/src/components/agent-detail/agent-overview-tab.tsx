// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ArrowDown,
  Brain,
  CalendarClock,
  CheckCircle2,
  Cpu,
  Database,
  FileInput,
  FileOutput,
  Globe,
  Maximize2,
  Minimize2,
  Plug,
  Puzzle,
  Server,
  SlidersHorizontal,
  Wrench,
} from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import type { AgentDetail } from "@appstrate/shared-types";
import { useAgentReadiness } from "../../hooks/use-agent-readiness";
import { useAgentConnectionReadiness } from "../../hooks/use-integrations";
import { useModels, useAgentModel } from "../../hooks/use-models";
import { useProxies, useAgentProxy } from "../../hooks/use-proxies";
import { useSchedules } from "../../hooks/use-schedules";
import { useAgentMemories, useAgentPinned } from "../../hooks/use-persistence";
import { Badge } from "../status-badge";
import { formatDateField } from "../../lib/markdown";

function MapNode({
  icon: Icon,
  label,
  value,
  href,
  tone = "default",
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  href?: string;
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
    <div className="text-muted-foreground flex flex-wrap gap-x-5 gap-y-2 text-[11px]">
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
}: {
  packageId: string;
  detail: AgentDetail;
}) {
  const { t } = useTranslation("agents");
  const [expanded, setExpanded] = useState(false);
  const { data: models } = useModels();
  const { data: agentModel } = useAgentModel(packageId);
  const { data: proxies } = useProxies();
  const { data: agentProxy } = useAgentProxy(packageId);
  const { data: schedules, isError: schedulesError } = useSchedules(packageId);
  const { data: connections, isError: connectionsError } = useAgentConnectionReadiness(packageId);
  const { data: memories, isError: memoriesError } = useAgentMemories(packageId);
  const { data: pinned, isError: pinnedError } = useAgentPinned(packageId);
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
  const connectionCount = connectionRows.filter(
    (row) => row.resolution?.resolved_connection_id,
  ).length;
  const connectionsKnown =
    detail.dependencies.integrations.length === 0 || (!!connections && !connectionsError);
  const ready =
    readiness.hasPrompt &&
    readiness.hasRequiredSkills &&
    readiness.hasRequiredConfig &&
    readiness.hasModel &&
    connectionsKnown &&
    !connections?.blocks_run;

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

  return (
    <div className="space-y-4" data-agent-overview>
      <section
        className={cn(
          "flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-center",
          ready ? "border-success/30 bg-success/5" : "border-warning/30 bg-warning/5",
        )}
      >
        {ready ? (
          <CheckCircle2 className="text-success size-5 shrink-0" aria-hidden />
        ) : (
          <AlertTriangle className="text-warning size-5 shrink-0" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {ready ? t("detail.overview.ready") : t("detail.overview.configurationRequired")}
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {ready
              ? t("detail.overview.readyDescription")
              : t("detail.overview.configurationRequiredDescription")}
          </p>
        </div>
        {!ready && (
          <Button asChild variant="outline" size="sm">
            <Link to={{ hash: "#configuration" }}>{t("detail.overview.complete")}</Link>
          </Button>
        )}
      </section>

      <section
        className={cn(
          "bg-background space-y-3 rounded-xl border p-3",
          expanded && "fixed inset-3 z-50 overflow-auto shadow-2xl",
        )}
        data-agent-map
      >
        <div className="flex items-start justify-between gap-3 px-1">
          <div>
            <h2 className="text-sm font-semibold">{t("detail.overview.installedAgent")}</h2>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {t("detail.overview.installedAgentDescription")}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((value) => !value)}
            aria-label={expanded ? t("detail.overview.collapse") : t("detail.overview.expand")}
          >
            {expanded ? <Minimize2 /> : <Maximize2 />}
            <span className="hidden sm:inline">
              {expanded ? t("detail.overview.collapse") : t("detail.overview.expand")}
            </span>
          </Button>
        </div>

        <div className="hidden gap-3 md:grid md:grid-cols-[minmax(13rem,0.72fr)_minmax(28rem,1.65fr)]">
          <Boundary
            label={t("detail.overview.appstrateConfiguration")}
            description={t("detail.overview.appstrateConfigurationDescription")}
          >
            <div className="space-y-2">
              {configNodes.map((node) => (
                <MapNode key={node.label} {...node} href="#configuration" />
              ))}
            </div>
          </Boundary>

          <Boundary
            label={t("detail.overview.portableBundle")}
            description={t("detail.overview.portableBundleDescription")}
          >
            <div className="grid gap-3 lg:grid-cols-[minmax(14rem,1fr)_minmax(13rem,0.8fr)]">
              <div className="flex flex-col items-stretch gap-2">
                <MapNode
                  icon={FileInput}
                  label={t("detail.overview.inputSchema")}
                  value={t("detail.overview.fieldCount", { count: inputCount })}
                  href="#bundle"
                />
                <ArrowDown className="text-muted-foreground mx-auto size-4" aria-hidden />
                <MapNode
                  icon={Cpu}
                  label={t("detail.overview.agent")}
                  value={detail.display_name ?? detail.id}
                  href="#bundle"
                />
                <ArrowDown className="text-muted-foreground mx-auto size-4" aria-hidden />
                <MapNode
                  icon={FileOutput}
                  label={t("detail.overview.outputSchema")}
                  value={detail.output?.schema ? t("detail.overview.declared") : unknown}
                  href="#bundle"
                />
              </div>
              <div className="space-y-2 border-l pl-3">
                {dependencyNodes.map((node) => (
                  <MapNode key={node.label} {...node} href="#bundle" />
                ))}
              </div>
            </div>
          </Boundary>
        </div>

        <div className="space-y-3 md:hidden" data-agent-map-mobile>
          <Boundary
            label={t("detail.overview.appstrateConfiguration")}
            description={t("detail.overview.appstrateConfigurationDescription")}
          >
            <div className="space-y-2">
              {configNodes.map((node) => (
                <MapNode key={node.label} {...node} href="#configuration" />
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
                href="#bundle"
              />
              <p className="text-muted-foreground pl-3 text-[11px]">
                ↓ {t("detail.overview.feeds")}
              </p>
              <MapNode
                icon={Cpu}
                label={t("detail.overview.agent")}
                value={detail.display_name ?? detail.id}
                href="#bundle"
              />
              <p className="text-muted-foreground pl-3 text-[11px]">
                ↓ {t("detail.overview.produces")}
              </p>
              <MapNode
                icon={FileOutput}
                label={t("detail.overview.outputSchema")}
                value={detail.output?.schema ? t("detail.overview.declared") : unknown}
                href="#bundle"
              />
              <div className="space-y-2 pt-2">
                {dependencyNodes.map((node) => (
                  <MapNode key={node.label} {...node} href="#bundle" />
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

      <div className="grid gap-3 sm:grid-cols-2">
        <section className="rounded-lg border p-4">
          <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            {t("detail.overview.lastRun")}
          </p>
          {detail.last_run ? (
            <div className="mt-3 flex items-center gap-3">
              <Badge status={detail.last_run.status} compact />
              <span className="text-muted-foreground text-xs">
                {formatDateField(detail.last_run.started_at, "datetime")}
              </span>
              <Link
                to={`/agents/${packageId}/runs/${detail.last_run.id}`}
                className="text-primary ml-auto text-xs hover:underline"
              >
                {t("detail.overview.open")}
              </Link>
            </div>
          ) : (
            <p className="text-muted-foreground mt-3 text-sm">{t("detail.overview.noRuns")}</p>
          )}
        </section>
        <section className="rounded-lg border p-4">
          <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            {t("detail.overview.nextExecution")}
          </p>
          {nextSchedule?.next_run_at ? (
            <div className="mt-3 flex items-center gap-3 text-sm">
              <CalendarClock className="text-muted-foreground size-4" />
              <span className="truncate">
                {formatDateField(nextSchedule.next_run_at, "datetime")}
              </span>
              <Link
                to={{ hash: "#configuration" }}
                className="text-primary ml-auto text-xs hover:underline"
              >
                {t("detail.overview.open")}
              </Link>
            </div>
          ) : schedulesError ? (
            <p className="text-muted-foreground mt-3 text-sm">{unknown}</p>
          ) : (
            <p className="text-muted-foreground mt-3 text-sm">{t("detail.overview.noSchedule")}</p>
          )}
        </section>
      </div>
    </div>
  );
}
