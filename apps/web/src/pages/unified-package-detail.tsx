// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { useParams, Link, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
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
import { usePackageOwnership } from "../hooks/use-org";
import { usePermissions } from "../hooks/use-permissions";
import { useProviders } from "../hooks/use-providers";
import { useDeleteProviderCredentials } from "../hooks/use-mutations";
import { usePackageInstallState, useTogglePackageInstall } from "../hooks/use-library";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { LoadingState } from "../components/page-states";
import { getVersionRedirect, hasActualChanges } from "../lib/version-helpers";
import { packageDetailPath } from "../lib/package-paths";
import { useAgentDetailUI } from "../stores/agent-detail-ui-store";
import { AlertTriangle } from "lucide-react";

// Shared components
import { ConfirmModal } from "../components/confirm-modal";
import { SharedHeader } from "../components/package-detail/shared-header";
import { PackageActionsDropdown } from "../components/package-detail/package-actions-dropdown";
import { VersionBanners } from "../components/version-banners";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { VersionHistory } from "../components/version-history";
import { DiffTab } from "../components/diff-tab";
import { CreateVersionModal } from "../components/create-version-modal";
import { ForkPackageModal } from "../components/fork-package-modal";
import { ProviderCredentialsForm } from "../components/provider-credentials-form";
import { ProviderConnectButton } from "../components/provider-connect-button";
// Agent-specific components
import { AgentActions } from "../components/package-detail/agent-actions";
import {
  AgentConnectorsTab,
  AgentRunsTab,
  AgentSchedulesTab,
  AgentMemoryTab,
  AgentApiTab,
} from "../components/package-detail/agent-tabs";
import { AgentModals } from "../components/package-detail/agent-modals";
import { AgentConfigurationTab } from "../components/package-detail/agent-configuration-tab";
import { RunAgentButton } from "../components/run-agent-button";
import { PackageCard } from "../components/package-card";
import { useAgentReadiness } from "../hooks/use-agent-readiness";
import { useModels, useAgentModel } from "../hooks/use-models";
import { useProxies } from "../hooks/use-proxies";

type DetailTab =
  | "connectors"
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

/** Primary companion file name per package type. */
const COMPANION_FILE_NAME: Record<PackageType, string> = {
  agent: "prompt.md",
  skill: "SKILL.md",
  tool: "TOOL.md",
  provider: "PROVIDER.md",
};

// ─── Agent Run Button (inline, no wrapper) ────────────────────────────

function AgentRunButtonInline({
  packageId,
  resolvedVersion,
  configSchemaOverride,
}: {
  packageId: string;
  resolvedVersion: string | undefined;
  configSchemaOverride?: JSONSchemaObject;
}) {
  const { t } = useTranslation("agents");
  const { data: detail } = usePackageDetail("agent", packageId);
  const { data: models } = useModels();
  const { data: agentModel } = useAgentModel(packageId);
  const readiness = useAgentReadiness(detail, agentModel?.modelId, models, configSchemaOverride);

  if (!detail) return null;

  const { hasRequiredConfig, hasModel, hasPrompt, hasRequiredSkills, hasRequiredTools } = readiness;
  // Provider connection checks are handled by the ConnectionSummaryModal
  const runDisabled =
    !hasPrompt || !hasRequiredSkills || !hasRequiredTools || !hasRequiredConfig || !hasModel;
  const runDisabledTitle = !hasPrompt
    ? t("detail.titleEmptyPrompt")
    : !hasRequiredSkills
      ? t("detail.titleMissingSkill")
      : !hasRequiredTools
        ? t("detail.titleMissingTool")
        : !hasRequiredConfig
          ? t("detail.titleConfig")
          : !hasModel
            ? t("detail.titleModel")
            : undefined;

  return (
    <RunAgentButton
      packageId={packageId}
      detail={detail}
      version={resolvedVersion}
      disabled={runDisabled}
      disabledTitle={runDisabledTitle}
      showLabel
    />
  );
}

function ModelRequiredAlert() {
  const { t } = useTranslation(["settings", "agents"]);
  const { data: models } = useModels();

  const hasAnyModel = models?.some((m) => m.isDefault && m.enabled);
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
  const { isOwned } = usePackageOwnership(packageId);
  const { isAdmin } = usePermissions();
  const isVersionView = !!versionParam;
  const resetUI = useAgentDetailUI((s) => s.reset);

  // Reset modal state when leaving the page or switching packages
  useEffect(() => {
    return () => resetUI();
  }, [packageId, resetUI]);

  // ── Data loading (unified) ──
  const { data: detail, isLoading, error } = usePackageDetail(type, packageId);

  // Configuration tab data (must be before early returns — hooks rule)
  const { data: orgProxies } = useProxies();
  const { data: orgModels } = useModels();

  // Provider-specific data (ProviderConfig with adminCredentialSchema, setupGuide, etc.)
  const providersQuery = useProviders();
  const providerConfig =
    type === "provider"
      ? providersQuery.data?.providers.find((p) => p.id === packageId)
      : undefined;
  const callbackUrl = type === "provider" ? providersQuery.data?.callbackUrl : undefined;

  // Agents list for "Used by" tab enrichment
  const { data: allAgents } = useAgents();

  // Type-narrowed aliases for type-specific branches
  const agentDetail = type === "agent" ? (detail as AgentDetail | undefined) : undefined;
  const pkgDetail = type !== "agent" ? (detail as OrgPackageItemDetail | undefined) : undefined;

  const displayName = agentDetail?.displayName ?? pkgDetail?.name ?? pkgDetail?.id ?? "";
  const source = agentDetail?.source ?? pkgDetail?.source;
  const version = agentDetail?.version ?? pkgDetail?.version;
  const hasUnarchivedChanges = agentDetail?.hasUnarchivedChanges ?? pkgDetail?.hasUnarchivedChanges;
  const forkedFrom = agentDetail?.forkedFrom ?? pkgDetail?.forkedFrom ?? null;

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
  const deleteCredentialsMutation = useDeleteProviderCredentials();
  const uninstallMutation = useTogglePackageInstall();
  const currentAppId = useCurrentApplicationId();
  const { installedAppNames, isInstalledInCurrentApp } = usePackageInstallState(packageId);
  const [forkOpen, setForkOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    type: "deleteCredentials" | "deletePackage" | "uninstallPackage";
    description: string;
  } | null>(null);

  // ── State ──
  const allValidTabs: DetailTab[] = [
    "connectors",
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
  const defaultTab: DetailTab =
    type === "agent" ? "runs" : type === "provider" ? "configuration" : "content";
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

  // Companion file for the dropdown (built from existing API fields)
  const companionContent = isHistoricalVersion ? versionDetail?.content : currentContent;
  const companionFile = companionContent
    ? { name: COMPANION_FILE_NAME[type], content: companionContent }
    : undefined;

  // ── Version-aware config schema ──
  // When viewing a historical version, use that version's config schema (or empty if none).
  // An empty schema means "no config fields" — distinct from undefined which means "use draft".
  const versionConfigSchema = (() => {
    const config = (versionDetail?.manifest as Record<string, unknown> | undefined)?.config as
      | { schema?: JSONSchemaObject }
      | undefined;
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
    description: type === "agent" ? agentDetail!.description : (pkgDetail?.description ?? ""),
    source: source ?? ("local" as const),
    type,
    version,
  };

  // ── Render ──
  const isBuiltIn = source === "system";
  const isImported = !!detail && !isOwned && !isBuiltIn;

  // Determine available tabs based on type

  const agentTabs: Array<{ id: DetailTab; label: string }> = [
    { id: "runs", label: t("detail.tabRuns") },
    { id: "connectors", label: t("detail.tabConnectors") },
    ...(effectiveShowConfigTab
      ? [{ id: "configuration" as DetailTab, label: t("detail.tabConfiguration") }]
      : []),
    { id: "schedules", label: t("detail.tabSchedules") },
    { id: "memory", label: t("detail.tabMemory") },
    { id: "api", label: t("detail.tabApi") },
  ];

  const pkgTabs: Array<{ id: DetailTab; label: string }> = [
    ...(isAdmin && type === "provider"
      ? [{ id: "configuration" as DetailTab, label: t("providers.configure", { ns: "settings" }) }]
      : []),
    {
      id: "content",
      label: type === "tool" ? t("editor.tabSource") : t(`editor.tabContent.${type}`),
    },
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

  const resolvedVersion = isHistoricalVersion ? versionDetail?.version : undefined;

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
              resolvedVersion={resolvedVersion}
              configSchemaOverride={isHistoricalVersion ? effectiveConfigSchema : undefined}
            />
          ) : undefined
        }
        actionsRight={
          type === "agent" ? (
            <AgentActions
              packageId={packageId}
              manifest={
                (isHistoricalVersion ? versionDetail?.manifest : agentDetail?.manifest) as
                  | Record<string, unknown>
                  | undefined
              }
              companionFile={companionFile}
              isOwned={isOwned}
              isImported={isImported}
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
                manifest={
                  (isHistoricalVersion ? versionDetail?.manifest : pkgDetail?.manifest) as
                    | Record<string, unknown>
                    | undefined
                }
                companionFile={companionFile}
                isOwned={isOwned}
                isImported={isImported}
                isBuiltIn={isBuiltIn}
                isHistoricalVersion={isHistoricalVersion}
                downloadVersion={downloadVersion}
                onDownload={downloadPackage}
                onCreateVersion={() => setCreateVersionOpen(true)}
                onFork={() => setForkOpen(true)}
                hasCredentials={providerConfig?.hasCredentials}
                onDeleteCredentials={() => {
                  setConfirmAction({
                    type: "deleteCredentials",
                    description: t("providers.deleteCredentialsConfirm", { ns: "settings" }),
                  });
                }}
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
        <TabsList>
          {tabDefs.map((td) => (
            <TabsTrigger key={td.id} value={td.id}>
              {td.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Tab content */}
      {type === "agent" && tab === "configuration" && (
        <AgentConfigurationTab
          packageId={packageId}
          configSchemaOverride={isHistoricalVersion ? effectiveConfigSchema : undefined}
          isHistorical={isHistoricalVersion}
        />
      )}
      {type === "agent" && tab === "connectors" && (
        <AgentConnectorsTab packageId={packageId} detail={agentDetail} />
      )}
      {type === "agent" && tab === "runs" && (
        <AgentRunsTab
          packageId={packageId}
          resolvedVersion={resolvedVersion}
          configSchemaOverride={isHistoricalVersion ? effectiveConfigSchema : undefined}
        />
      )}
      {type === "agent" && tab === "schedules" && <AgentSchedulesTab packageId={packageId} />}
      {type === "agent" && tab === "memory" && <AgentMemoryTab packageId={packageId} />}
      {type === "agent" && tab === "api" && <AgentApiTab packageId={packageId} />}

      {type !== "agent" && tab === "content" && pkgDetail && (
        <div className="border-border bg-card rounded-lg border p-4">
          <pre className="text-muted-foreground bg-muted/50 overflow-x-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
            {type === "tool"
              ? ((isHistoricalVersion && versionDetail?.sourceCode != null
                  ? versionDetail.sourceCode
                  : pkgDetail.sourceCode) ?? "")
              : isHistoricalVersion && versionDetail?.content != null
                ? versionDetail.content
                : pkgDetail.content}
          </pre>
        </div>
      )}

      {type === "provider" && tab === "configuration" && providerConfig && (
        <div className="border-border bg-card rounded-lg border p-4">
          <ProviderCredentialsForm
            provider={providerConfig}
            callbackUrl={callbackUrl}
            footer={<ProviderConnectButton provider={providerConfig} />}
          />
        </div>
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
                  displayName={agent.displayName}
                  description={agent.description}
                  type="agent"
                  source={agent.source}
                  keywords={agent.keywords}
                  providerIds={Object.keys(agent.dependencies.providers ?? {})}
                  runningRuns={agent.runningRuns}
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

      {/* Agent modals */}
      {type === "agent" && <AgentModals packageId={packageId} />}

      <ConfirmModal
        open={!!confirmAction}
        onClose={() => setConfirmAction(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={confirmAction?.description ?? ""}
        isPending={
          deleteCredentialsMutation.isPending ||
          deletePkgMutation.isPending ||
          uninstallMutation.isPending
        }
        confirmLabel={
          confirmAction?.type === "uninstallPackage"
            ? t("packages.uninstall", { ns: "settings" })
            : undefined
        }
        onConfirm={() => {
          if (!confirmAction) return;
          const close = () => setConfirmAction(null);
          if (confirmAction.type === "deleteCredentials") {
            deleteCredentialsMutation.mutate(packageId, { onSuccess: close });
          } else if (confirmAction.type === "uninstallPackage") {
            if (!currentAppId) return;
            uninstallMutation.mutate(
              { appId: currentAppId, packageId, installed: true },
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
