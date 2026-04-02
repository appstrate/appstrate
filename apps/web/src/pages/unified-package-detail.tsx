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
  usePackageDownload,
  useDeletePackage,
} from "../hooks/use-packages";
import type { AgentDetail, OrgPackageItemDetail, PackageType } from "@appstrate/shared-types";
import type { JSONSchemaObject } from "@appstrate/core/form";
import { usePackageOwnership } from "../hooks/use-org";
import { usePermissions } from "../hooks/use-permissions";
import { useProviders } from "../hooks/use-providers";
import { useDeleteProviderCredentials } from "../hooks/use-mutations";
import { LoadingState } from "../components/page-states";
import { getVersionRedirect } from "../lib/version-helpers";
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
import { DraftDiffView } from "../components/draft-diff-view";
import { CreateVersionModal } from "../components/create-version-modal";
import { ForkPackageModal } from "../components/fork-package-modal";
import { ProviderCredentialsForm } from "../components/provider-credentials-form";
import { ProviderConnectButton } from "../components/provider-connect-button";
// Flow-specific components
import { AgentActions } from "../components/package-detail/agent-actions";
import {
  AgentConnectorsTab,
  AgentRunsTab,
  AgentSchedulesTab,
  AgentMemoriesTab,
  AgentApiTab,
} from "../components/package-detail/agent-tabs";
import { AgentModals } from "../components/package-detail/agent-modals";
import { AgentConfigurationTab } from "../components/package-detail/agent-configuration-tab";
import { RunAgentButton } from "../components/run-agent-button";
import { useAgentReadiness } from "../hooks/use-agent-readiness";
import { useModels, useAgentModel } from "../hooks/use-models";
import { useProxies } from "../hooks/use-proxies";

type DetailTab =
  | "connectors"
  | "runs"
  | "configuration"
  | "schedules"
  | "memories"
  | "api"
  | "versions"
  | "changes"
  | "content"
  | "usedBy";

const EMPTY_CONFIG_SCHEMA: JSONSchemaObject = { type: "object", properties: {} };

// ─── Flow Run Button (inline, no wrapper) ────────────────────────────

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

  // Type-narrowed aliases for type-specific branches
  const agentDetail = type === "agent" ? (detail as AgentDetail | undefined) : undefined;
  const pkgDetail = type !== "agent" ? (detail as OrgPackageItemDetail | undefined) : undefined;

  const displayName = agentDetail?.displayName ?? pkgDetail?.name ?? pkgDetail?.id ?? "";
  const source = agentDetail?.source ?? pkgDetail?.source;
  const version = agentDetail?.version ?? pkgDetail?.version;
  const versionCount = agentDetail?.versionCount ?? pkgDetail?.versionCount;
  const hasUnpublishedChanges =
    agentDetail?.hasUnpublishedChanges ?? pkgDetail?.hasUnpublishedChanges;
  const forkedFrom = agentDetail?.forkedFrom ?? pkgDetail?.forkedFrom ?? null;

  const { data: versionDetail, isLoading: versionLoading } = useVersionDetail(
    type,
    packageId,
    versionParam,
  );

  const hasDraftChanges = source !== "system" && !!hasUnpublishedChanges;
  const { data: latestVersionForDiff } = useVersionDetail(
    type,
    packageId,
    hasDraftChanges ? "latest" : undefined,
  );

  const downloadPackage = usePackageDownload(scope, name);
  const deletePkgMutation = useDeletePackage(type);
  const deleteCredentialsMutation = useDeleteProviderCredentials();
  const [forkOpen, setForkOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    type: "deleteCredentials" | "deletePackage";
    description: string;
  } | null>(null);

  // ── State ──
  const allValidTabs: DetailTab[] = [
    "connectors",
    "runs",
    "configuration",
    "schedules",
    "memories",
    "api",
    "versions",
    "changes",
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
  // Reset tab if it becomes invalid (e.g. #changes when draft is published)
  useEffect(() => {
    if (tab === "changes" && (!hasDraftChanges || isVersionView)) setTab(defaultTab);
    if (tab === "versions" && source === "system") setTab(defaultTab);
  }, [tab, hasDraftChanges, isVersionView, source, defaultTab, setTab]);

  const [createVersionOpen, setCreateVersionOpen] = useState(false);
  const [diffTabOverride, setDiffTab] = useState<"manifest" | "content" | null>(null);

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
    hasDraftChanges,
  });
  if ("redirect" in versionResult) {
    return <Navigate to={versionResult.redirect} replace />;
  }
  const { isHistoricalVersion } = versionResult;

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
    versionCount,
    hasUnpublishedChanges,
  };

  // ── Diff tab logic ──
  const currentManifest = type === "agent" ? agentDetail?.manifest : pkgDetail?.manifest;
  const currentContent = agentDetail?.prompt ?? pkgDetail?.content;
  const contentLabel = type === "agent" ? t("version.diffPrompt") : t("packages.content");

  const hasManifestChanges =
    JSON.stringify(currentManifest ?? {}) !== JSON.stringify(latestVersionForDiff?.manifest ?? {});
  const hasContentChanges =
    latestVersionForDiff?.content != null &&
    currentContent != null &&
    latestVersionForDiff.content !== currentContent;

  const diffTab = (() => {
    const preferred = diffTabOverride ?? "manifest";
    if (preferred === "content" && !hasContentChanges && hasManifestChanges) return "manifest";
    if (preferred === "manifest" && !hasManifestChanges && hasContentChanges) return "content";
    return preferred;
  })();

  // ── Render ──
  const isBuiltIn = source === "system";

  // Determine available tabs based on type

  const agentTabs: Array<{ id: DetailTab; label: string }> = [
    { id: "runs", label: t("detail.tabRuns") },
    {
      id: "connectors",
      label: t("detail.tabConnectors"),
    },
    ...(effectiveShowConfigTab
      ? [{ id: "configuration" as DetailTab, label: t("detail.tabConfiguration") }]
      : []),
    {
      id: "schedules",
      label: t("detail.tabSchedules"),
    },
    {
      id: "memories",
      label: t("detail.tabMemories"),
    },
    { id: "api", label: t("detail.tabApi") },
  ];

  const pkgTabs: Array<{ id: DetailTab; label: string; badge?: string }> = [
    ...(isAdmin && type === "provider"
      ? [
          {
            id: "configuration" as DetailTab,
            label: t("providers.configure", { ns: "settings" }),
          },
        ]
      : []),
    { id: "content", label: t("packages.content") },
    { id: "usedBy", label: t("packages.usedBy") },
  ];

  const tabDefs = type === "agent" ? agentTabs : pkgTabs;

  const resolvedVersion = isHistoricalVersion ? versionDetail?.version : undefined;

  return (
    <>
      <SharedHeader
        detail={unifiedForHeader}
        packageId={packageId}
        versionParam={versionParam}
        hasDraftChanges={hasDraftChanges}
        isHistoricalVersion={isHistoricalVersion}
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
              isOwned={isOwned}
              isHistoricalVersion={isHistoricalVersion}
              hasDraftChanges={hasDraftChanges}
              downloadVersion={downloadVersion}
              downloadPackage={downloadPackage}
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
                isOwned={isOwned}
                isBuiltIn={isBuiltIn}
                isHistoricalVersion={isHistoricalVersion}
                hasDraftChanges={hasDraftChanges}
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
                    description: t("packages.deleteConfirm", {
                      type: typeLabel,
                      name: nameStr,
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
        hasDraftChanges={hasDraftChanges}
        latestUrl={packageDetailPath(type, packageId)}
        latestVersion={version}
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
          {!isBuiltIn && <TabsTrigger value="versions">{t("version.history")}</TabsTrigger>}
          {hasDraftChanges && !isVersionView && (
            <TabsTrigger value="changes">{t("version.diff")}</TabsTrigger>
          )}
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
      {type === "agent" && tab === "memories" && <AgentMemoriesTab packageId={packageId} />}
      {type === "agent" && tab === "api" && <AgentApiTab packageId={packageId} />}

      {type !== "agent" && tab === "content" && pkgDetail && (
        <div className="border-border bg-card rounded-lg border p-4">
          <pre className="text-muted-foreground bg-muted/50 overflow-x-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
            {isHistoricalVersion && versionDetail?.content != null
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

      {type !== "agent" && tab === "usedBy" && pkgDetail && (
        <div className="border-border bg-card rounded-lg border p-4">
          {pkgDetail.agents.length === 0 ? (
            <p className="text-muted-foreground py-4 text-center text-sm">
              {t("packages.noFlows")}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {pkgDetail.agents.map((f) => (
                <Link
                  key={f.id}
                  to={`/agents/${f.id}`}
                  className="border-border hover:border-primary text-foreground inline-flex items-center rounded-md border px-2.5 py-1 text-sm no-underline transition-colors"
                >
                  {f.displayName || f.id}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "versions" && <VersionHistory packageId={packageId} type={type} isOwned={isOwned} />}

      {tab === "changes" && hasDraftChanges && !isVersionView && latestVersionForDiff && (
        <>
          <Tabs
            value={diffTab}
            onValueChange={(v) => setDiffTab(v as "manifest" | "content")}
            className="mb-4"
          >
            <TabsList>
              {hasManifestChanges && (
                <TabsTrigger value="manifest">{t("version.diffManifest")}</TabsTrigger>
              )}
              {hasContentChanges && <TabsTrigger value="content">{contentLabel}</TabsTrigger>}
            </TabsList>
          </Tabs>
          {diffTab === "manifest" && hasManifestChanges && (
            <DraftDiffView
              original={JSON.stringify(latestVersionForDiff.manifest ?? {}, null, 2)}
              modified={JSON.stringify(currentManifest ?? {}, null, 2)}
              language="json"
            />
          )}
          {diffTab === "content" &&
            hasContentChanges &&
            currentContent != null &&
            latestVersionForDiff.content != null && (
              <DraftDiffView
                original={latestVersionForDiff.content}
                modified={currentContent}
                language={type === "agent" ? "markdown" : undefined}
              />
            )}
          {!hasManifestChanges && !hasContentChanges && (
            <p className="text-muted-foreground py-4 text-center text-sm">{t("version.noDiff")}</p>
          )}
        </>
      )}
      {tab === "changes" && hasDraftChanges && !isVersionView && !latestVersionForDiff && (
        <p className="text-muted-foreground py-4 text-center text-sm">
          {t("version.noVersionYet")}
        </p>
      )}

      <CreateVersionModal
        open={createVersionOpen}
        onClose={() => setCreateVersionOpen(false)}
        type={type}
        packageId={packageId}
      />

      <ForkPackageModal
        open={forkOpen}
        onClose={() => setForkOpen(false)}
        packageId={packageId}
        defaultName={name ?? ""}
        type={type}
      />

      {/* Flow modals */}
      {type === "agent" && <AgentModals packageId={packageId} />}

      <ConfirmModal
        open={!!confirmAction}
        onClose={() => setConfirmAction(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={confirmAction?.description ?? ""}
        isPending={deleteCredentialsMutation.isPending || deletePkgMutation.isPending}
        onConfirm={() => {
          if (!confirmAction) return;
          const close = () => setConfirmAction(null);
          if (confirmAction.type === "deleteCredentials") {
            deleteCredentialsMutation.mutate(packageId, { onSuccess: close });
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
    </>
  );
}
