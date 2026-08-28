// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense, useState, useEffect } from "react";
import { toast } from "sonner";
import { useParams, Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { cn } from "@appstrate/ui/cn";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import {
  usePackageDetail,
  useVersionDetail,
  useAgentBundleExport,
  usePackageDownload,
  useDeletePackage,
  useAgents,
  useVersionInfo,
} from "../hooks/use-packages";
import type { AgentDetail, OrgPackageItemDetail, PackageType } from "@appstrate/shared-types";
import type { JSONSchemaObject } from "@appstrate/core/form";
import { usePackageInstallState, useTogglePackageInstall } from "../hooks/use-library";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { EmptyState, LoadingState } from "../components/page-states";
import { CardGrid } from "../components/card-grid";
import { getVersionRedirect, hasActualChanges } from "../lib/version-helpers";
import { packageDetailPath } from "../lib/package-paths";
import { Layers } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";

// Shared components
import { ConfirmModal } from "../components/confirm-modal";
import { SharedHeader } from "../components/package-detail/shared-header";
import { PackageActionsDropdown } from "../components/package-detail/package-actions-dropdown";
import { VersionBanners } from "../components/version-banners";
import { VersionHistory } from "../components/version-history";
import { DiffTab } from "../components/diff-tab";
import { FileExplorer } from "../components/package-files/file-explorer";
import { ManifestOverview } from "../components/package-manifest/manifest-overview";
import { primaryDisplayFile } from "../lib/package-files";
import { CreateVersionModal } from "../components/create-version-modal";
import { ForkPackageModal } from "../components/fork-package-modal";
// Agent-specific components
import { AgentActions } from "../components/package-detail/agent-actions";
import { AgentRunsTab, AgentMemoryTab } from "../components/package-detail/agent-tabs";
import { AgentOverviewTab } from "../components/agent-detail/agent-overview-tab";
import { AgentSettingsView } from "../components/agent-detail/agent-settings-view";
import { DetailTabsList, DetailTabsTrigger } from "../components/agent-detail/agent-local-tabs";
import { AGENT_DETAIL_TABS } from "../lib/agent-detail-tabs";
import { RunAgentButton } from "../components/run-agent-button";
import { PackageCard } from "../components/package-card";
import { diagnosticsAllowLaunch, useAgentDiagnostics } from "../hooks/use-agent-diagnostics";

type DetailTab =
  "overview" | "runs" | "settings" | "memory" | "versions" | "diff" | "content" | "usedBy";

const EMPTY_CONFIG_SCHEMA: JSONSchemaObject = { type: "object", properties: {} };
const AgentBundleEditorModal = lazy(() =>
  import("./package-editor").then((module) => ({ default: module.AgentBundleEditorModal })),
);

// ─── Agent Run Button (inline, no wrapper) ────────────────────────────

function AgentReadinessBadge({
  packageId,
  versionLabel,
}: {
  packageId: string;
  versionLabel: string | undefined;
}) {
  const { t } = useTranslation("agents");
  const diagnostics = useAgentDiagnostics(packageId, versionLabel);
  const result = diagnostics.data;
  const status = diagnostics.isLoading ? "loading" : (result?.status ?? "warning");
  const statusLabel = diagnostics.isLoading
    ? t("detail.diagnostics.assessing")
    : result?.status === "healthy"
      ? t("detail.diagnostics.readyBadge")
      : result?.status === "blocking"
        ? t("detail.diagnostics.blockingTitle", { count: result.blocking_count })
        : t("detail.diagnostics.warningTitle", { count: result?.warning_count ?? 0 });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "focus:ring-ring inline-flex items-center rounded-md border border-transparent px-2.5 py-0.5 text-xs font-medium transition-colors focus:ring-2 focus:ring-offset-2 focus:outline-none",
            status === "healthy"
              ? "bg-success/20 text-success hover:bg-success/25"
              : status === "blocking"
                ? "bg-destructive/20 text-destructive hover:bg-destructive/25"
                : "bg-warning/20 text-warning hover:bg-warning/25",
          )}
        >
          {statusLabel}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-4">
        <p className="text-sm font-semibold">{t("detail.diagnostics.title")}</p>
        <p className="text-muted-foreground mt-1 text-xs">{statusLabel}</p>
        {result && result.diagnostics.length > 0 && (
          <ul className="mt-3 space-y-2">
            {result.diagnostics.slice(0, 4).map((item) => (
              <li key={`${item.code}:${item.field}`} className="text-xs">
                {item.title}
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

function AgentRunButtonInline({
  packageId,
  detail,
  versionLabel,
}: {
  packageId: string;
  detail: AgentDetail;
  versionLabel: string | undefined;
}) {
  const diagnostics = useAgentDiagnostics(packageId, versionLabel);
  const result = diagnostics.data;
  const runDisabled = diagnostics.isLoading || !diagnosticsAllowLaunch(result);
  const runDisabledTitle = result?.diagnostics.find(
    (item) => item.severity === "blocking" && !item.recoverable_on_launch,
  )?.explanation;
  const connectionWarning =
    result?.diagnostics.some(
      (item) => item.severity === "blocking" && item.recoverable_on_launch,
    ) ?? false;

  return (
    <RunAgentButton
      packageId={packageId}
      detail={detail}
      version={versionLabel}
      disabled={runDisabled}
      disabledTitle={runDisabledTitle}
      connectionWarning={!runDisabled && connectionWarning}
      variant="outline"
      size="sm"
      className="bg-card"
      showLabel
    />
  );
}

// ─── Main Page ──────────────────────────────────────────────────────

export function UnifiedPackageDetailPage({ type }: { type: PackageType }) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  const location = useLocation();
  const navigate = useNavigate();
  const {
    scope,
    name,
    version: versionParam,
  } = useParams<{ scope: string; name: string; version?: string }>();
  const packageId = `${scope}/${name}`;
  const isVersionView = !!versionParam;

  // ── Data loading (unified) ──
  const { data: detail, isLoading, error } = usePackageDetail(type, packageId);
  const { data: versionInfo } = useVersionInfo(type, type === "agent" ? packageId : undefined);

  // Agents list for "Used by" tab enrichment
  const { data: allAgents } = useAgents();

  // Type-narrowed aliases for type-specific branches
  const agentDetail = type === "agent" ? (detail as AgentDetail | undefined) : undefined;
  const pkgDetail = type !== "agent" ? (detail as OrgPackageItemDetail | undefined) : undefined;

  const displayName = agentDetail?.display_name ?? pkgDetail?.name ?? pkgDetail?.id ?? "";
  const source = agentDetail?.source ?? pkgDetail?.source;
  const version = agentDetail?.version ?? pkgDetail?.version;
  const hasUnarchivedChanges =
    agentDetail?.has_unarchived_changes ?? pkgDetail?.has_unarchived_changes;
  const forkedFrom = agentDetail?.forked_from ?? pkgDetail?.forked_from ?? null;
  // Mutability is gated on whether the org owns the package row, not on its scope name.
  // Every package returned here is already org-scoped server-side, so anything that is not a
  // read-only system package is freely editable/deletable (registry checks happen at publish).
  const isOwned = source !== "system";

  const { data: versionDetail, isLoading: versionLoading } = useVersionDetail(
    type,
    packageId,
    versionParam,
  );

  // Diff: fetch latest version when timestamps suggest changes
  const hasTimestampChanges = source !== "system" && !!hasUnarchivedChanges;
  const { data: latestVersionForDiff } = useVersionDetail(
    type,
    packageId,
    hasTimestampChanges ? "latest" : undefined,
  );
  // Refine: once we have the latest version data, check for real content diff
  const currentManifest = type === "agent" ? agentDetail?.manifest : pkgDetail?.manifest;
  const currentContent = agentDetail?.prompt ?? pkgDetail?.content;
  const hasArchivableChanges =
    hasTimestampChanges &&
    (!latestVersionForDiff ||
      hasActualChanges(latestVersionForDiff, currentManifest, currentContent));

  const downloadPackage = usePackageDownload(scope, name);
  const downloadBundle = useAgentBundleExport(scope, name);
  const deletePkgMutation = useDeletePackage(type);
  const uninstallMutation = useTogglePackageInstall();
  const currentAppId = useCurrentApplicationId();
  const { installedAppNames, isInstalledInCurrentApp } = usePackageInstallState(packageId);
  const [forkOpen, setForkOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    type: "deletePackage" | "uninstallPackage";
    description: string;
  } | null>(null);

  // ── State ──
  const allValidTabs: DetailTab[] =
    type === "agent"
      ? [...AGENT_DETAIL_TABS]
      : ["overview", "versions", "diff", "content", "usedBy"];
  // Agents open on their installation overview. Every other type opens where its SUBSTANCE
  // lives, which `lib/package-files.ts` already encodes and which does not
  // depend on how much metadata the author happened to fill in: a skill IS its
  // SKILL.md (`source: "content"`) → open the files; an mcp-server IS its
  // manifest (`source: "manifest"`, it has no content file at all) → open the
  // rendered view. Same distinction that made the old content tab carry a
  // filename as its label. Pure derivation, so a URL that already names a tab
  // still wins in `useTabWithHash`.
  const defaultTab: DetailTab =
    type === "agent"
      ? "overview"
      : primaryDisplayFile(type).source === "content"
        ? "content"
        : "overview";
  const [tab, setTab] = useTabWithHash<DetailTab>(allValidTabs, defaultTab);
  const openAgentSettings = (section: "map" | "files" | "model") => {
    const search = new URLSearchParams(location.search);
    if (section === "model") search.delete("agentSettings");
    else search.set("agentSettings", section);
    search.delete("agentConfig");
    void navigate(
      { pathname: location.pathname, search: search.toString(), hash: "settings" },
      { replace: true },
    );
  };

  useEffect(() => {
    if (type !== "agent") return;
    const legacyTab = location.hash.replace(/^#/, "");
    if (legacyTab !== "map" && legacyTab !== "files" && legacyTab !== "configuration") return;
    const search = new URLSearchParams(location.search);
    const section =
      legacyTab === "configuration" ? search.get("agentConfig") || "model" : legacyTab;
    if (section === "model") search.delete("agentSettings");
    else search.set("agentSettings", section);
    search.delete("agentConfig");
    void navigate(
      { pathname: location.pathname, search: search.toString(), hash: "settings" },
      { replace: true },
    );
  }, [location.hash, location.pathname, location.search, navigate, type]);
  // Reset tab if it becomes invalid
  useEffect(() => {
    if (tab === "diff" && (!hasArchivableChanges || isVersionView)) setTab(defaultTab);
    if (tab === "versions" && source === "system") setTab(defaultTab);
  }, [tab, hasArchivableChanges, isVersionView, source, defaultTab, setTab]);
  const [createVersionOpen, setCreateVersionOpen] = useState(false);
  const [bundleEditorOpen, setBundleEditorOpen] = useState(false);
  const requestedBundleTab = new URLSearchParams(location.search).get("agentBundle");
  const bundleEditorInitialTab =
    requestedBundleTab === "general" ||
    requestedBundleTab === "prompt" ||
    requestedBundleTab === "schema" ||
    requestedBundleTab === "skills" ||
    requestedBundleTab === "integrations" ||
    requestedBundleTab === "json"
      ? requestedBundleTab
      : undefined;
  const closeBundleEditor = () => {
    setBundleEditorOpen(false);
    if (!requestedBundleTab) return;
    const search = new URLSearchParams(location.search);
    search.delete("agentBundle");
    navigate(
      { pathname: location.pathname, search: search.toString(), hash: location.hash },
      { replace: true },
    );
  };

  // ── Loading / Error ──
  if (isLoading || (isVersionView && versionLoading)) return <LoadingState />;
  if (error || !detail) {
    return <Navigate to="/" replace />;
  }

  // ── Version redirect ──
  const versionResult = getVersionRedirect({
    type,
    packageId,
    versionParam,
    versionDetail,
    liveVersion: version,
    hasArchivableChanges,
  });
  if ("redirect" in versionResult) {
    return <Navigate to={versionResult.redirect} replace />;
  }
  const { isHistoricalVersion } = versionResult;

  // The manifest the page is looking at — the archived one when a version is
  // pinned, the live draft otherwise. Same rule the file explorer follows.
  const effectiveManifest = isHistoricalVersion ? versionDetail?.manifest : currentManifest;

  // ── Version-aware input schema ──
  // A version snapshot does not carry the workspace's model, proxy or saved
  // values. The only honest form shape available here is the archived AFPS
  // input schema. An empty schema is distinct from undefined, which means
  // "fall back to the current draft" in the form components.
  const versionInputSchema = (() => {
    const input = versionDetail?.manifest?.input as { schema?: JSONSchemaObject } | undefined;
    return input?.schema;
  })();
  const effectiveConfigSchema = isHistoricalVersion
    ? (versionInputSchema ?? EMPTY_CONFIG_SCHEMA)
    : agentDetail?.config?.schema;
  const downloadVersion = (isHistoricalVersion ? versionDetail?.version : version) ?? undefined;

  // ── Unified detail for SharedHeader ──
  const historicalManifestName =
    typeof versionDetail?.manifest?.display_name === "string"
      ? versionDetail.manifest.display_name
      : packageId;
  const historicalManifestDescription =
    typeof versionDetail?.manifest?.description === "string"
      ? versionDetail.manifest.description
      : "";
  const unifiedForHeader = {
    id: packageId,
    displayName: isHistoricalVersion ? historicalManifestName : displayName,
    description: isHistoricalVersion
      ? historicalManifestDescription
      : type === "agent"
        ? (agentDetail!.description ?? "")
        : (pkgDetail?.description ?? ""),
    source: source ?? ("local" as const),
    type,
    version: isHistoricalVersion ? versionDetail?.version : version,
  };

  // ── Render ──
  const isBuiltIn = source === "system";

  // Determine available tabs based on type

  // The artifact file explorer — one generic tab for every package type. Keeps
  // the historical `"content"` id so existing deep links (#content) still land.
  const filesTab: { id: DetailTab; label: string } = {
    id: "content",
    label: t("detail.tabFiles"),
  };

  // The rendered manifest, next to the raw artifact it comes from.
  const overviewTab: { id: DetailTab; label: string } = {
    id: "overview",
    label: t("detail.tabOverview"),
  };

  const agentTabLabels: Record<(typeof AGENT_DETAIL_TABS)[number], string> = {
    overview: t("detail.overview.summary"),
    runs: t("detail.tabRuns"),
    memory: t("detail.tabMemory"),
    settings: t("detail.tabSettings"),
  };
  const agentTabs: Array<{ id: DetailTab; label: string }> = AGENT_DETAIL_TABS.map((id) => ({
    id,
    label: agentTabLabels[id],
  }));

  const pkgTabs: Array<{ id: DetailTab; label: string }> = [
    overviewTab,
    filesTab,
    { id: "usedBy", label: t("packages.usedBy") },
  ];

  // Shared tabs appended to all package types
  const sharedTabs: Array<{ id: DetailTab; label: string }> =
    type === "agent"
      ? []
      : [
          ...(!isBuiltIn ? [{ id: "versions" as DetailTab, label: t("version.archives") }] : []),
          ...(hasArchivableChanges && !isVersionView
            ? [{ id: "diff" as DetailTab, label: t("version.diff") }]
            : []),
        ];

  const tabDefs = [...(type === "agent" ? agentTabs : pkgTabs), ...sharedTabs];

  const versionLabel = isHistoricalVersion ? versionDetail?.version : undefined;

  return (
    <div>
      <SharedHeader
        detail={unifiedForHeader}
        isHistoricalVersion={isHistoricalVersion}
        hasUnarchivedChanges={hasArchivableChanges}
        latestPublishedVersion={versionInfo?.latest_published_version}
        activeSubpage={
          type === "agent"
            ? {
                label: agentTabLabels[tab as (typeof AGENT_DETAIL_TABS)[number]],
              }
            : undefined
        }
        statusBadges={
          type === "agent" ? (
            <AgentReadinessBadge packageId={packageId} versionLabel={versionLabel} />
          ) : undefined
        }
        actionsLeft={
          type === "agent" && agentDetail ? (
            <AgentRunButtonInline
              packageId={packageId}
              detail={agentDetail}
              versionLabel={versionLabel}
            />
          ) : undefined
        }
        actionsRight={
          type === "agent" ? (
            <AgentActions
              packageId={packageId}
              isOwned={isOwned}
              isHistoricalVersion={isHistoricalVersion}
              downloadVersion={downloadVersion}
              downloadPackage={downloadPackage}
              downloadBundle={downloadBundle}
              onCreateVersion={() => setCreateVersionOpen(true)}
              onFork={() => setForkOpen(true)}
              onEditBundle={() => setBundleEditorOpen(true)}
            />
          ) : (
            <div className="flex items-center gap-2">
              <PackageActionsDropdown
                packageId={packageId}
                type={type}
                isOwned={isOwned}
                isBuiltIn={isBuiltIn}
                isHistoricalVersion={isHistoricalVersion}
                downloadVersion={downloadVersion}
                onDownload={downloadPackage}
                onCreateVersion={() => setCreateVersionOpen(true)}
                onFork={() => setForkOpen(true)}
                canDeletePackage={!!pkgDetail && pkgDetail.agents.length === 0}
                onDeletePackage={() => {
                  if (!pkgDetail) return;
                  const nameStr = pkgDetail.name || pkgDetail.id;
                  const typeLabel = t(`packages.type.${type}`, { ns: "settings" });
                  setConfirmAction({
                    type: "deletePackage",
                    description:
                      installedAppNames.length > 0
                        ? t("packages.deleteConfirmWithApps", {
                            type: typeLabel,
                            name: nameStr,
                            apps: installedAppNames.join(", "),
                            ns: "settings",
                          })
                        : t("packages.deleteConfirm", {
                            type: typeLabel,
                            name: nameStr,
                            ns: "settings",
                          }),
                  });
                }}
                canUninstall={isInstalledInCurrentApp && source !== "system"}
                onUninstall={() => {
                  setConfirmAction({
                    type: "uninstallPackage",
                    description: t("packages.uninstallConfirm", {
                      name: displayName,
                      ns: "settings",
                    }),
                  });
                }}
              />
            </div>
          )
        }
      />

      <VersionBanners
        isHistorical={isHistoricalVersion}
        versionDetail={versionDetail}
        activeUrl={packageDetailPath(type, packageId)}
      />

      {!isOwned && type !== "agent" && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-blue-500/30 bg-blue-500/5 px-4 py-3 text-sm">
          <span className="text-blue-400">{t("ownership.readOnly")}</span>
          {forkedFrom && (
            <span className="text-muted-foreground">
              — {t("ownership.forkedFrom")}
              <Link
                to={packageDetailPath(type, forkedFrom)}
                className="text-blue-400 hover:underline"
              >
                {forkedFrom}
              </Link>
            </span>
          )}
        </div>
      )}
      {isOwned && forkedFrom && (
        <div className="border-border/50 bg-muted/30 mb-4 flex items-center gap-3 rounded-lg border px-4 py-3 text-sm">
          <span className="text-muted-foreground">
            {t("ownership.forkedFrom")}
            <Link
              to={packageDetailPath(type, forkedFrom)}
              className="text-blue-400 hover:underline"
            >
              {forkedFrom}
            </Link>
          </span>
        </div>
      )}

      {type === "agent" && agentDetail && (
        <div className="overflow-visible" data-agent-detail-surface>
          <Tabs value={tab} onValueChange={(value) => setTab(value as DetailTab)}>
            <DetailTabsList className="mt-6 mb-3">
              {agentTabs.map((item) => (
                <DetailTabsTrigger key={item.id} value={item.id}>
                  {item.label}
                </DetailTabsTrigger>
              ))}
            </DetailTabsList>

            <TabsContent
              value="overview"
              className="bg-card mt-0 overflow-hidden rounded-lg border p-6 shadow-sm"
            >
              <AgentOverviewTab
                packageId={packageId}
                detail={agentDetail}
                version={versionLabel}
                isHistorical={isHistoricalVersion}
                currentManifest={currentManifest}
                currentContent={currentContent}
                surface="summary"
                onOpenFiles={() => openAgentSettings("files")}
                cardHeaders
                contained
              />
            </TabsContent>
            <TabsContent
              value="runs"
              className="bg-card mt-0 overflow-hidden rounded-lg border p-6 shadow-sm"
            >
              <AgentRunsTab
                packageId={packageId}
                versionLabel={versionLabel}
                configSchemaOverride={isHistoricalVersion ? effectiveConfigSchema : undefined}
              />
            </TabsContent>
            <TabsContent
              value="settings"
              className="bg-card mt-0 overflow-hidden rounded-lg border shadow-sm"
            >
              <AgentSettingsView
                packageId={packageId}
                detail={agentDetail}
                version={versionLabel}
                configSchemaOverride={isHistoricalVersion ? effectiveConfigSchema : undefined}
                isHistorical={isHistoricalVersion}
                currentManifest={currentManifest}
                currentContent={currentContent}
              />
            </TabsContent>
            <TabsContent
              value="memory"
              className="bg-card mt-0 overflow-hidden rounded-lg border shadow-sm"
            >
              <AgentMemoryTab packageId={packageId} />
            </TabsContent>
          </Tabs>
        </div>
      )}

      {type !== "agent" && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as DetailTab)} className="mb-4">
          <div className="max-w-full overflow-x-auto pb-1">
            <TabsList className="w-max">
              {tabDefs.map((td) => (
                <TabsTrigger key={td.id} value={td.id}>
                  {td.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </Tabs>
      )}

      {/* Non-Agent tab content */}
      {/* Both follow the version being viewed: the explorer through
          `versionLabel`, the overview through the manifest picked above. */}
      {type !== "agent" && tab === "overview" && (
        <ManifestOverview manifest={effectiveManifest} type={type} />
      )}

      {type !== "agent" && tab === "content" && (
        <FileExplorer packageId={packageId} type={type} version={versionLabel} />
      )}

      {type !== "agent" &&
        tab === "usedBy" &&
        pkgDetail &&
        (() => {
          const agentIds = new Set(pkgDetail.agents.map((a) => a.id));
          const enrichedAgents = allAgents?.filter((a) => agentIds.has(a.id)) ?? [];
          return (
            <CardGrid
              items={enrichedAgents}
              itemKey={(agent) => agent.id}
              renderCard={(agent) => (
                <PackageCard
                  id={agent.id}
                  displayName={agent.display_name ?? agent.id}
                  description={agent.description ?? null}
                  type="agent"
                  source={agent.source}
                  keywords={agent.keywords}
                  runningRuns={agent.running_runs}
                />
              )}
              empty={<EmptyState message={t("packages.noAgents")} icon={Layers} compact />}
            />
          );
        })()}

      {type !== "agent" && tab === "versions" && (
        <VersionHistory packageId={packageId} type={type} isOwned={isOwned} />
      )}

      {type !== "agent" && tab === "diff" && latestVersionForDiff && (
        <DiffTab
          type={type}
          latestVersion={latestVersionForDiff}
          currentManifest={currentManifest}
          currentContent={currentContent}
        />
      )}

      <CreateVersionModal
        open={createVersionOpen}
        onClose={() => setCreateVersionOpen(false)}
        type={type}
        packageId={packageId}
        hasUnarchivedChanges={hasArchivableChanges}
      />

      {(bundleEditorOpen || Boolean(bundleEditorInitialTab)) && agentDetail && (
        <Suspense fallback={<LoadingState />}>
          <AgentBundleEditorModal
            detail={agentDetail}
            initialTab={bundleEditorInitialTab}
            onClose={closeBundleEditor}
          />
        </Suspense>
      )}

      <ForkPackageModal
        open={forkOpen}
        onClose={() => setForkOpen(false)}
        packageId={packageId}
        defaultName={name ?? ""}
        type={type}
      />

      <ConfirmModal
        open={!!confirmAction}
        onClose={() => setConfirmAction(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={confirmAction?.description ?? ""}
        isPending={deletePkgMutation.isPending || uninstallMutation.isPending}
        confirmLabel={
          confirmAction?.type === "uninstallPackage"
            ? t("packages.uninstall", { ns: "settings" })
            : undefined
        }
        onConfirm={() => {
          if (!confirmAction) return;
          const close = () => setConfirmAction(null);
          if (confirmAction.type === "uninstallPackage") {
            if (!currentAppId) return;
            uninstallMutation.mutate(
              { applicationId: currentAppId, packageId, installed: true },
              {
                onSuccess: close,
                onError: (err) =>
                  toast.error(err instanceof Error ? err.message : t("error.generic")),
              },
            );
          } else {
            deletePkgMutation.mutate(packageId, {
              onSuccess: close,
              onError: (err) =>
                toast.error(
                  err instanceof Error
                    ? err.message
                    : t("packages.deleteDependedOn", { ns: "settings" }),
                ),
            });
          }
        }}
      />
    </div>
  );
}
