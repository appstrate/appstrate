// SPDX-License-Identifier: Apache-2.0

/**
 * Paramètres › Carte: the agent map on a wide screen, and on a narrow one the
 * same reading order as a list (configuration, bundle, memory), which a canvas
 * cannot offer at phone width.
 */

import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Brain,
  CalendarClock,
  Cpu,
  Database,
  FileInput,
  FileOutput,
  Globe,
  Plug,
  Puzzle,
  Server,
  SlidersHorizontal,
  Wrench,
} from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import type { AgentDetail } from "@appstrate/shared-types";
import { useAgentConnectionReadiness } from "../../hooks/use-integrations";
import { useModels, useAgentModel } from "../../hooks/use-models";
import { useProxies, useAgentProxy } from "../../hooks/use-proxies";
import { useSchedules } from "../../hooks/use-schedules";
import { useAgentMemories, useAgentPinned } from "../../hooks/use-persistence";
import { agentSettingsHref } from "../../lib/settings-section-href";
import { AgentMapView } from "./agent-map-view";

function MapNode({
  icon: Icon,
  label,
  value,
  href,
  onClick,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  href?: string;
  onClick?: () => void;
}) {
  const body = (
    <div
      className={cn(
        "bg-background flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2.5 text-left shadow-sm",
        (href || onClick) && "hover:border-foreground/25 transition-colors",
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
  return href ? <Link to={href}>{body}</Link> : body;
}

function Boundary({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-muted/25 rounded-xl border border-dashed p-3">
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

export function AgentMapSurface({
  packageId,
  detail,
  version,
  onOpenFiles,
}: {
  packageId: string;
  detail: AgentDetail;
  version: string | undefined;
  /** The bundle rows open Paramètres › Fichiers. */
  onOpenFiles: () => void;
}) {
  return (
    <div className="px-4 py-4 md:px-6 md:py-6" data-agent-overview>
      <div className="hidden md:block">
        <AgentMapView packageId={packageId} version={version} />
      </div>
      <MobileMap packageId={packageId} detail={detail} onOpenFiles={onOpenFiles} />
    </div>
  );
}

function MobileMap({
  packageId,
  detail,
  onOpenFiles,
}: {
  packageId: string;
  detail: AgentDetail;
  onOpenFiles: () => void;
}) {
  const { t } = useTranslation("agents");
  const location = useLocation();
  const { data: models } = useModels();
  const { data: agentModel } = useAgentModel(packageId);
  const { data: proxies } = useProxies();
  const { data: agentProxy } = useAgentProxy(packageId);
  const { data: schedules, isError: schedulesError } = useSchedules(packageId);
  const { data: connections, isError: connectionsError } = useAgentConnectionReadiness(packageId);
  const { data: memories, isError: memoriesError } = useAgentMemories(packageId);
  const { data: pinned, isError: pinnedError } = useAgentPinned(packageId);

  const unknown = t("detail.overview.unknown");
  const defaultModel = models?.find((model) => model.is_default);
  const resolvedModel = models?.find((model) => model.id === agentModel?.modelId) ?? defaultModel;
  const defaultProxy = proxies?.find((proxy) => proxy.is_default && proxy.enabled);
  const resolvedProxy = proxies?.find((proxy) => proxy.id === agentProxy?.proxyId) ?? defaultProxy;
  const inputCount = Object.keys(detail.input?.schema?.properties ?? {}).length;
  const configuredCount = Object.keys(detail.input?.values ?? {}).length;
  const connectionCount = (connections?.integrations ?? []).filter(
    (row) => (row.resolution?.resolved_connection_ids.length ?? 0) > 0,
  ).length;

  const configNodes = [
    {
      icon: CalendarClock,
      label: t("detail.overview.schedules"),
      value:
        schedules && !schedulesError
          ? t("detail.overview.itemCount", { count: schedules.length })
          : unknown,
      href: agentSettingsHref(location.pathname, "schedules"),
    },
    {
      icon: Cpu,
      label: t("detail.overview.model"),
      value: resolvedModel?.label ?? unknown,
      href: agentSettingsHref(location.pathname, "model"),
    },
    {
      icon: SlidersHorizontal,
      label: t("detail.overview.inputValues"),
      value: t("detail.overview.configuredInputs", {
        configured: configuredCount,
        total: inputCount,
      }),
      href: agentSettingsHref(location.pathname, "inputs"),
    },
    {
      icon: Globe,
      label: t("detail.overview.proxy"),
      value: resolvedProxy?.label ?? unknown,
      href: agentSettingsHref(location.pathname, "proxy"),
    },
    {
      icon: Plug,
      label: t("detail.overview.connections"),
      value:
        connections && !connectionsError
          ? t("detail.overview.itemCount", { count: connectionCount })
          : unknown,
      href: agentSettingsHref(location.pathname, "connections"),
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
      value: t("detail.overview.itemCount", { count: (detail.dependencies.skills ?? []).length }),
    },
    {
      icon: Server,
      label: t("detail.overview.mcpServers"),
      value: t("detail.overview.itemCount", {
        count: (detail.dependencies.mcp_servers ?? []).length,
      }),
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
              <MapNode key={node.label} {...node} />
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
            <p className="text-muted-foreground pl-3 text-[11px]">↓ {t("detail.overview.feeds")}</p>
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
          to={{ pathname: location.pathname, hash: "#memory" }}
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
  );
}
