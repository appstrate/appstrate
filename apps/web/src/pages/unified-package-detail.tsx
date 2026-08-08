// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, lazy, Suspense } from "react";
import { toast } from "sonner";
import { useParams, Link, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { useAppConfig } from "../hooks/use-app-config";
import {
  usePackageDetail,
  useVersionDetail,
  useAgentBundleExport,
  usePackageDownload,
  useDeletePackage,
  useAgents,
} from "../hooks/use-packages";
import type { AgentDetail, OrgPackageItemDetail, PackageType } from "@appstrate/shared-types";
import type { JSONSchemaObject } from "@appstrate/core/form";
import { usePermissions } from "../hooks/use-permissions";
import { usePackageInstallState, useTogglePackageInstall } from "../hooks/use-library";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { LoadingState } from "../components/page-states";
import { getVersionRedirect, hasActualChanges } from "../lib/version-helpers";
import { packageDetailPath } from "../lib/package-paths";
import { isModelSelectable } from "../lib/model-selectability";
import { AlertTriangle } from "lucide-react";

// Shared components
import { ConfirmModal } from "../components/confirm-modal";
import { SharedHeader } from "../components/package-detail/shared-header";
import { PackageActionsDropdown } from "../components/package-detail/package-actions-dropdown";
import { VersionBanners } from "../components/version-banners";
import { Alert, AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
import { VersionHistory } from "../components/version-history";
import { DiffTab } from "../components/diff-tab";
import { FileExplorer } from "../components/package-files/file-explorer";
import { ManifestOverview } from "../components/package-manifest/manifest-overview";
import { primaryDisplayFile } from "../lib/package-files";
import { CreateVersionModal } from "../components/create-version-modal";
import { ForkPackageModal } from "../components/fork-package-modal";
// Agent-specific components
import { AgentActions } from "../components/package-detail/agent-actions";
import {
  AgentRunsTab,
  AgentSchedulesTab,
  AgentMemoryTab,
  AgentApiTab,
} from "../components/package-detail/agent-tabs";
import { AgentConnectionsSection } from "../components/package-detail/agent-connections-section";
import { AgentConfigurationTab } from "../components/package-detail/agent-configuration-tab";
// Mount point for the opt-in `agent-map` module. Lazy so React Flow and the
// map's own chunk never enter the bundle of a deployment that runs without it.
const AgentMapView = lazy(() =>
  import("../modules/agent-map/agent-map-view").then((m) => ({ default: m.AgentMapView })),
);
import { RunAgentButton } from "../components/run-agent-button";
import { PackageCard } from "../components/package-card";
import { useAgentReadiness } from "../hooks/use-agent-readiness";
import { useAgentIntegrationsReadiness } from "../hooks/use-agent-integrations-readiness";
import { useModels, useAgentModel } from "../hooks/use-models";
import { useProxies } from "../hooks/use-proxies";

type DetailTab =
  | "map"
  | "overview"
  | "connections"
  | "runs"
  | "configuration"
  | "schedules"
  | "memory"
  | "api"
  | "versions"
  | "diff"
  | "content"
  | "usedBy";

const EMPTY_CONFIG_SCHEMA: JSONSchemaObject = { type: "object", properties: {} };

// ─── Agent Run Button (inline, no wrapper) ────────────────────────────

function AgentRunButtonInline({
  packageId,
  versionLabel,
  configSchemaOverride,
}: {
  packageId: string;
  versionLabel: string | undefined;
  configSchemaOverride?: JSONSchemaObject;
}) {
  const { t } = useTranslation("agents");
  const { data: detail } = usePackageDetail("agent", packageId);
  const { data: models } = useModels();
  const { data: agentModel } = useAgentModel(packageId);
  const readiness = useAgentReadiness(detail, agentModel?.modelId, models, configSchemaOverride);
  // Launch-time integration readiness — drives the non-blocking orange badge.
  // Same server resolver as the run-kickoff 412 (see useAgentIntegrationsReadiness).
  const integrationsReady = useAgentIntegrationsReadiness(packageId);

  if (!detail) return null;

  const { hasRequiredConfig, hasModel, hasPrompt, hasRequiredSkills } = readiness;
  // Integration connection gaps don't disable Run — they surface as a warning
  // badge here and the recovery modal at run-kickoff (412 → MissingConnectionsModal).
  const runDisabled = !hasPrompt || !hasRequiredSkills || !hasRequiredConfig || !hasModel;
  const runDisabledTitle = !hasPrompt
    ? t("detail.titleEmptyPrompt")
    : !hasRequiredSkills
      ? t("detail.titleMissingSkill")
      : !hasRequiredConfig
        ? t("detail.titleConfig")
        : !hasModel
          ? t("detail.titleModel")
          : undefined;

  return (
    <RunAgentButton
      packageId={packageId}
      detail={detail}
      version={versionLabel}
      disabled={runDisabled}
      disabledTitle={runDisabledTitle}
      connectionWarning={!runDisabled && !integrationsReady.ready}
      showLabel
    />
  );
}

function ModelRequiredAlert() {
  const { t } = useTranslation(["settings", "agents"]);
  const { data: models } = useModels();

  const hasAnyModel = models?.some((m) => m.is_default && isModelSelectable(m));
  if (hasAnyModel || hasAnyModel === undefined) return null;

  return (
    <Alert variant="destructive" className="mb-4">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{t("models.alert.noModel", { ns: "settings" })}</AlertTitle>
      <AlertDescription className="flex items-center justify-between">
        <span>{t("models.alert.noModelDescription", { ns: "settings" })}</span>
      </AlertDescription>
    </Alert>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────

export function UnifiedPackageDetailPage({ type }: { type: PackageType }) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  const {
    scope,
    name,
    version: versionParam,
  } = useParams<{ scope: string; name: string; version?: string }>();
  const packageId = `${scope}/${name}`;
  const { isAdmin } = usePermissions();
  const isVersionView = !!versionParam;

  // ── Data loading (unified) ──
  const { data: detail, isLoading, error } = usePackageDetail(type, packageId);

  // Configuration tab data (must be before early returns — hooks rule)
  const { data: orgProxies } = useProxies();
  const { data: orgModels } = useModels();

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
  // `agentMap` is contributed by the opt-in `agent-map` module; absent from
  // MODULES it is `false`, and the tab is neither offered nor reachable by hash.
  const { features } = useAppConfig();
  const agentMapEnabled = !!features.agentMap;
  const allValidTabs: DetailTab[] = [
    ...(agentMapEnabled ? (["map"] as DetailTab[]) : []),
    "overview",
    "connections",
    "runs",
    "configuration",
    "schedules",
    "memory",
    "api",
    "versions",
    "diff",
    "content",
    "usedBy",
  ];
  // Configuration tab visibility (uses draft schema — version-aware override applied after loading)
  const draftConfigSchema = agentDetail?.config?.schema;
  const hasDraftConfigSchema = !!(
    draftConfigSchema?.properties && Object.keys(draftConfigSchema.properties).length > 0
  );
  const hasModelsAvailable = !!orgModels && orgModels.length > 0;
  const hasProxiesAvailable = !!orgProxies && orgProxies.length > 0;
  const hasMissingRequiredConfig =
    type === "agent" &&
    hasDraftConfigSchema &&
    draftConfigSchema?.required?.some((key) => {
      const val = agentDetail?.config?.current?.[key];
      return val === undefined || val === null || val === "";
    });
  // Agents open on their runs. Every other type opens where its SUBSTANCE
  // lives, which `lib/package-files.ts` already encodes and which does not
  // depend on how much metadata the author happened to fill in: a skill IS its
  // SKILL.md (`source: "content"`) → open the files; an mcp-server IS its
  // manifest (`source: "manifest"`, it has no content file at all) → open the
  // rendered view. Same distinction that made the old content tab carry a
  // filename as its label. Pure derivation, so a URL that already names a tab
  // still wins in `useTabWithHash`.
  const defaultTab: DetailTab =
    type === "agent"
      ? "runs"
      : primaryDisplayFile(type).source === "content"
        ? "content"
        : "overview";
  const [tab, setTab] = useTabWithHash<DetailTab>(allValidTabs, defaultTab);
  // Reset tab if it becomes invalid
  useEffect(() => {
    if (tab === "diff" && (!hasArchivableChanges || isVersionView)) setTab(defaultTab);
    if (tab === "versions" && source === "system") setTab(defaultTab);
  }, [tab, hasArchivableChanges, isVersionView, source, defaultTab, setTab]);
  const [createVersionOpen, setCreateVersionOpen] = useState(false);

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

  // ── Version-aware config schema ──
  // When viewing a historical version, use that version's config schema (or empty if none).
  // An empty schema means "no config fields" — distinct from undefined which means "use draft".
  const versionConfigSchema = (() => {
    const config = versionDetail?.manifest?.config as { schema?: JSONSchemaObject } | undefined;
    return config?.schema;
  })();
  const effectiveConfigSchema = isHistoricalVersion
    ? (versionConfigSchema ?? EMPTY_CONFIG_SCHEMA)
    : agentDetail?.config?.schema;
  const hasEffectiveConfigSchema = !!(
    effectiveConfigSchema?.properties && Object.keys(effectiveConfigSchema.properties).length > 0
  );
  // Override showConfigTab for historical versions with their own config schema
  const effectiveShowConfigTab =
    isAdmin &&
    type === "agent" &&
    (hasEffectiveConfigSchema || hasModelsAvailable || hasProxiesAvailable);

  const downloadVersion = (isHistoricalVersion ? versionDetail?.version : version) ?? undefined;

  // ── Unified detail for SharedHeader ──
  const unifiedForHeader = {
    id: packageId,
    displayName,
    description:
      type === "agent" ? (agentDetail!.description ?? "") : (pkgDetail?.description ?? ""),
    source: source ?? ("local" as const),
    type,
    version,
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

  const agentTabs: Array<{ id: DetailTab; label: string }> = [
    { id: "runs", label: t("detail.tabRuns") },
    ...(agentMapEnabled ? [{ id: "map" as DetailTab, label: t("detail.tabMap") }] : []),
    { id: "connections", label: t("detail.tabConnections") },
    ...(effectiveShowConfigTab
      ? [{ id: "configuration" as DetailTab, label: t("detail.tabConfiguration") }]
      : []),
    { id: "schedules", label: t("detail.tabSchedules") },
    { id: "memory", label: t("detail.tabMemory") },
    { id: "api", label: t("detail.tabApi") },
    overviewTab,
    filesTab,
  ];

  const pkgTabs: Array<{ id: DetailTab; label: string }> = [
    overviewTab,
    filesTab,
    { id: "usedBy", label: t("packages.usedBy") },
  ];

  // Shared tabs appended to all package types
  const sharedTabs: Array<{ id: DetailTab; label: string }> = [
    ...(!isBuiltIn ? [{ id: "versions" as DetailTab, label: t("version.archives") }] : []),
    ...(hasArchivableChanges && !isVersionView
      ? [{ id: "diff" as DetailTab, label: t("version.diff") }]
      : []),
  ];

  const tabDefs = [...(type === "agent" ? agentTabs : pkgTabs), ...sharedTabs];

  const versionLabel = isHistoricalVersion ? versionDetail?.version : undefined;

  return (
    <div className="p-6">
      <SharedHeader
        detail={unifiedForHeader}
        isHistoricalVersion={isHistoricalVersion}
        hasUnarchivedChanges={hasArchivableChanges}
        actionsLeft={
          type === "agent" ? (
            <AgentRunButtonInline
              packageId={packageId}
              versionLabel={versionLabel}
              configSchemaOverride={isHistoricalVersion ? effectiveConfigSchema : undefined}
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

      {type === "agent" && <ModelRequiredAlert />}

      {!isOwned && (
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

      {type === "agent" && hasMissingRequiredConfig && (
        <div className="border-warning/30 bg-warning/5 mb-4 flex items-center gap-3 rounded-lg border px-4 py-3 text-sm">
          <span className="text-warning text-base leading-none">⚠</span>
          <span className="text-warning">{t("detail.configAlert")}</span>
        </div>
      )}

      {/* Tab bar */}
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

      {/* Tab content */}
      {type === "agent" && tab === "configuration" && (
        <AgentConfigurationTab
          packageId={packageId}
          configSchemaOverride={isHistoricalVersion ? effectiveConfigSchema : undefined}
          isHistorical={isHistoricalVersion}
        />
      )}
      {type === "agent" && agentMapEnabled && tab === "map" && (
        // Historical versions map the published manifest they pin, so the
        // drawing matches the definition being inspected.
        <Suspense fallback={<LoadingState />}>
          <AgentMapView packageId={packageId} version={versionLabel} />
        </Suspense>
      )}
      {type === "agent" && tab === "connections" && agentDetail && (
        <AgentConnectionsSection packageId={packageId} detail={agentDetail} />
      )}
      {type === "agent" && tab === "runs" && (
        <AgentRunsTab
          packageId={packageId}
          versionLabel={versionLabel}
          configSchemaOverride={isHistoricalVersion ? effectiveConfigSchema : undefined}
        />
      )}
      {type === "agent" && tab === "schedules" && <AgentSchedulesTab packageId={packageId} />}
      {type === "agent" && tab === "memory" && <AgentMemoryTab packageId={packageId} />}
      {type === "agent" && tab === "api" && <AgentApiTab packageId={packageId} />}

      {/* Both follow the version being viewed: the explorer through
          `versionLabel`, the overview through the manifest picked above. */}
      {tab === "overview" && <ManifestOverview manifest={effectiveManifest} type={type} />}

      {tab === "content" && (
        <FileExplorer packageId={packageId} type={type} version={versionLabel} />
      )}

      {type !== "agent" &&
        tab === "usedBy" &&
        pkgDetail &&
        (() => {
          const agentIds = new Set(pkgDetail.agents.map((a) => a.id));
          const enrichedAgents = allAgents?.filter((a) => agentIds.has(a.id)) ?? [];
          return enrichedAgents.length === 0 ? (
            <p className="text-muted-foreground py-4 text-center text-sm">
              {t("packages.noAgents")}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {enrichedAgents.map((agent) => (
                <PackageCard
                  key={agent.id}
                  id={agent.id}
                  displayName={agent.display_name ?? agent.id}
                  description={agent.description ?? null}
                  type="agent"
                  source={agent.source}
                  keywords={agent.keywords}
                  runningRuns={agent.running_runs}
                />
              ))}
            </div>
          );
        })()}

      {tab === "versions" && <VersionHistory packageId={packageId} type={type} isOwned={isOwned} />}

      {tab === "diff" && latestVersionForDiff && (
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
