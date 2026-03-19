import { useState, useEffect } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import {
  usePackageDetail,
  useVersionDetail,
  usePackageDownload,
  useDeletePackage,
} from "../hooks/use-packages";
import type {
  FlowDetail,
  JSONSchemaObject,
  OrgPackageItemDetail,
  PackageType,
} from "@appstrate/shared-types";
import { useOrg, usePackageOwnership } from "../hooks/use-org";
import { useProviders } from "../hooks/use-providers";
import { useDeleteProviderCredentials } from "../hooks/use-mutations";
import { LoadingState } from "../components/page-states";
import { getVersionRedirect } from "../lib/version-helpers";
import { packageDetailPath } from "../lib/package-paths";
import { useFlowDetailUI } from "../stores/flow-detail-ui-store";
import { Settings, CheckCircle, AlertTriangle } from "lucide-react";

// Shared components
import { SharedHeader } from "../components/package-detail/shared-header";
import { PackageActionsDropdown } from "../components/package-detail/package-actions-dropdown";
import { VersionBanners } from "../components/version-banners";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { VersionHistory } from "../components/version-history";
import { DraftDiffView } from "../components/draft-diff-view";
import { CreateVersionModal } from "../components/create-version-modal";
import { ForkPackageModal } from "../components/fork-package-modal";
import { ProviderCredentialsModal } from "../components/provider-credentials-modal";
// Flow-specific components
import { FlowActions } from "../components/package-detail/flow-actions";
import {
  FlowConnectorsTab,
  FlowExecutionsTab,
  FlowSchedulesTab,
  FlowMemoriesTab,
  FlowApiTab,
} from "../components/package-detail/flow-tabs";
import { FlowModals } from "../components/package-detail/flow-modals";
import { FlowConfigurationTab } from "../components/package-detail/flow-configuration-tab";
import { RunFlowButton } from "../components/run-flow-button";
import { useFlowReadiness } from "../hooks/use-flow-readiness";
import { useModels, useFlowModel } from "../hooks/use-models";
import { useProxies } from "../hooks/use-proxies";
import { computeProvidersSummary } from "../lib/provider-status";

type DetailTab =
  | "connectors"
  | "executions"
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

function FlowRunButtonInline({
  packageId,
  resolvedVersion,
  configSchemaOverride,
}: {
  packageId: string;
  resolvedVersion: string | undefined;
  configSchemaOverride?: JSONSchemaObject;
}) {
  const { t } = useTranslation("flows");
  const { data: detail } = usePackageDetail("flow", packageId);
  const { data: models } = useModels();
  const { data: flowModel } = useFlowModel(packageId);
  const readiness = useFlowReadiness(detail, flowModel?.modelId, models, configSchemaOverride);

  if (!detail) return null;

  const {
    allConnected,
    hasReconnectionNeeded,
    hasRequiredConfig,
    hasModel,
    hasPrompt,
    hasRequiredSkills,
    hasRequiredTools,
  } = readiness;
  const runDisabled =
    !hasPrompt ||
    !hasRequiredSkills ||
    !hasRequiredTools ||
    !allConnected ||
    hasReconnectionNeeded ||
    !hasRequiredConfig ||
    !hasModel;
  const runDisabledTitle = !hasPrompt
    ? t("detail.titleEmptyPrompt")
    : !hasRequiredSkills
      ? t("detail.titleMissingSkill")
      : !hasRequiredTools
        ? t("detail.titleMissingTool")
        : hasReconnectionNeeded
          ? t("detail.titleReconnect", { defaultValue: "Reconnect services first" })
          : !allConnected
            ? t("detail.titleConnect")
            : !hasRequiredConfig
              ? t("detail.titleConfig")
              : !hasModel
                ? t("detail.titleModel")
                : undefined;

  return (
    <RunFlowButton
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
  const { t } = useTranslation(["settings", "flows"]);
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
  const { t } = useTranslation(["flows", "settings", "common"]);
  const {
    scope,
    name,
    version: versionParam,
  } = useParams<{ scope: string; name: string; version?: string }>();
  const packageId = `${scope}/${name}`;
  const { isOrgAdmin } = useOrg();
  const { isOwned } = usePackageOwnership(packageId);
  const isVersionView = !!versionParam;
  const resetUI = useFlowDetailUI((s) => s.reset);

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
  const flowDetail = type === "flow" ? (detail as FlowDetail | undefined) : undefined;
  const pkgDetail = type !== "flow" ? (detail as OrgPackageItemDetail | undefined) : undefined;

  const displayName = flowDetail?.displayName ?? pkgDetail?.name ?? pkgDetail?.id ?? "";
  const source = flowDetail?.source ?? pkgDetail?.source;
  const version = flowDetail?.version ?? pkgDetail?.version;
  const versionCount = flowDetail?.versionCount ?? pkgDetail?.versionCount;
  const hasUnpublishedChanges =
    flowDetail?.hasUnpublishedChanges ?? pkgDetail?.hasUnpublishedChanges;
  const forkedFrom = flowDetail?.forkedFrom ?? pkgDetail?.forkedFrom ?? null;

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

  // ── State ──
  const allValidTabs: DetailTab[] = [
    "connectors",
    "executions",
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
  const draftConfigSchema = flowDetail?.config?.schema;
  const hasDraftConfigSchema = !!(
    draftConfigSchema?.properties && Object.keys(draftConfigSchema.properties).length > 0
  );
  const hasModelsAvailable = isOrgAdmin && !!orgModels && orgModels.length > 0;
  const hasProxiesAvailable = isOrgAdmin && !!orgProxies && orgProxies.length > 0;
  const showConfigTab =
    type === "flow" && (hasDraftConfigSchema || hasModelsAvailable || hasProxiesAvailable);

  const hasDisconnectedServices =
    type === "flow" &&
    flowDetail?.dependencies.providers.some(
      (s) => s.status !== "connected" || s.scopesSufficient === false,
    );
  const hasMissingRequiredConfig =
    type === "flow" &&
    hasDraftConfigSchema &&
    draftConfigSchema?.required?.some((key) => {
      const val = flowDetail?.config?.current?.[key];
      return val === undefined || val === null || val === "";
    });
  const defaultTab: DetailTab =
    type === "flow"
      ? hasDisconnectedServices
        ? "connectors"
        : hasMissingRequiredConfig && showConfigTab
          ? "configuration"
          : "executions"
      : "content";
  const [tab, setTab] = useTabWithHash<DetailTab>(allValidTabs, defaultTab);
  // Reset tab if it becomes invalid (e.g. #changes when draft is published)
  useEffect(() => {
    if (tab === "changes" && (!hasDraftChanges || isVersionView)) setTab(defaultTab);
    if (tab === "versions" && source === "system") setTab(defaultTab);
  }, [tab, hasDraftChanges, isVersionView, source, defaultTab, setTab]);

  const [createVersionOpen, setCreateVersionOpen] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
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
    : flowDetail?.config?.schema;
  const hasEffectiveConfigSchema = !!(
    effectiveConfigSchema?.properties && Object.keys(effectiveConfigSchema.properties).length > 0
  );
  // Override showConfigTab for historical versions with their own config schema
  const effectiveShowConfigTab =
    type === "flow" && (hasEffectiveConfigSchema || hasModelsAvailable || hasProxiesAvailable);

  const downloadVersion = isHistoricalVersion ? versionDetail?.version : version;

  // ── Unified detail for SharedHeader ──
  const unifiedForHeader = {
    id: packageId,
    displayName,
    description: type === "flow" ? flowDetail!.description : (pkgDetail?.description ?? ""),
    source: source ?? ("local" as const),
    type,
    version,
    versionCount,
    hasUnpublishedChanges,
  };

  // ── Diff tab logic ──
  const currentManifest = type === "flow" ? flowDetail?.manifest : pkgDetail?.manifest;
  const currentContent = flowDetail?.prompt ?? pkgDetail?.content;
  const contentLabel = type === "flow" ? t("version.diffPrompt") : t("packages.content");

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
  const providersSummary =
    type === "flow" && flowDetail
      ? computeProvidersSummary(flowDetail.dependencies.providers, t)
      : null;

  const flowTabs: Array<{ id: DetailTab; label: string }> = [
    { id: "executions", label: t("detail.tabExecutions") },
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
    {
      id: "content",
      label:
        type === "provider" ? t("providers.configure", { ns: "settings" }) : t("packages.content"),
    },
    { id: "usedBy", label: t("packages.usedBy") },
  ];

  const tabDefs = type === "flow" ? flowTabs : pkgTabs;

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
          type === "flow" ? (
            <FlowRunButtonInline
              packageId={packageId}
              resolvedVersion={resolvedVersion}
              configSchemaOverride={isHistoricalVersion ? effectiveConfigSchema : undefined}
            />
          ) : undefined
        }
        actionsRight={
          type === "flow" ? (
            <FlowActions
              packageId={packageId}
              manifest={
                (isHistoricalVersion ? versionDetail?.manifest : flowDetail?.manifest) as
                  | Record<string, unknown>
                  | undefined
              }
              isOrgAdmin={isOrgAdmin}
              isOwned={isOwned}
              isHistoricalVersion={isHistoricalVersion}
              hasDraftChanges={hasDraftChanges}
              downloadVersion={downloadVersion ?? undefined}
              downloadPackage={downloadPackage}
              onCreateVersion={() => setCreateVersionOpen(true)}
              onFork={() => setForkOpen(true)}
            />
          ) : isOrgAdmin ? (
            <>
              {type === "provider" && providerConfig && (
                <Button variant="outline" size="sm" onClick={() => setCredentialsOpen(true)}>
                  {providerConfig.enabled ? (
                    <CheckCircle size={14} className="text-emerald-500" />
                  ) : (
                    <Settings size={14} />
                  )}
                  {t("providers.configure", { ns: "settings" })}
                </Button>
              )}
              <PackageActionsDropdown
                packageId={packageId}
                type={type}
                manifest={
                  (isHistoricalVersion ? versionDetail?.manifest : pkgDetail?.manifest) as
                    | Record<string, unknown>
                    | undefined
                }
                isOrgAdmin={isOrgAdmin}
                isOwned={isOwned}
                isBuiltIn={isBuiltIn}
                isHistoricalVersion={isHistoricalVersion}
                hasDraftChanges={hasDraftChanges}
                downloadVersion={downloadVersion ?? undefined}
                onDownload={downloadPackage}
                onCreateVersion={() => setCreateVersionOpen(true)}
                onFork={() => setForkOpen(true)}
                hasCredentials={providerConfig?.hasCredentials}
                onDeleteCredentials={() => {
                  if (!confirm(t("providers.deleteCredentialsConfirm", { ns: "settings" }))) return;
                  deleteCredentialsMutation.mutate(packageId);
                }}
                canDeletePackage={!!pkgDetail && pkgDetail.flows.length === 0}
                onDeletePackage={() => {
                  if (!pkgDetail) return;
                  const nameStr = pkgDetail.name || pkgDetail.id;
                  const typeLabel = t(`packages.type.${type}`, { ns: "settings" });
                  if (
                    !confirm(
                      t("packages.deleteConfirm", {
                        type: typeLabel,
                        name: nameStr,
                        ns: "settings",
                      }),
                    )
                  )
                    return;
                  deletePkgMutation.mutate(packageId, {
                    onError: (err) =>
                      alert(
                        err instanceof Error
                          ? err.message
                          : t("packages.deleteDependedOn", { ns: "settings" }),
                      ),
                  });
                }}
              />
            </>
          ) : undefined
        }
      />

      <VersionBanners
        isHistorical={isHistoricalVersion}
        versionDetail={versionDetail}
        hasDraftChanges={hasDraftChanges}
        latestUrl={packageDetailPath(type, packageId)}
        latestVersion={version}
      />

      {type === "flow" && <ModelRequiredAlert />}

      {!isOwned && (
        <div className="flex items-center gap-3 rounded-lg border border-blue-500/30 bg-blue-500/5 px-4 py-3 mb-4 text-sm">
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
        <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/30 px-4 py-3 mb-4 text-sm">
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

      {type === "flow" && providersSummary && providersSummary.actionCount > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 mb-4 text-sm">
          <span className="text-warning text-base leading-none">⚠</span>
          <span className="text-warning">
            {t("detail.providersAlert", { count: providersSummary.actionCount })}
          </span>
        </div>
      )}

      {type === "flow" && hasMissingRequiredConfig && (
        <div className="flex items-center gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 mb-4 text-sm">
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
      {type === "flow" && tab === "configuration" && (
        <FlowConfigurationTab
          packageId={packageId}
          configSchemaOverride={isHistoricalVersion ? effectiveConfigSchema : undefined}
          isHistorical={isHistoricalVersion}
        />
      )}
      {type === "flow" && tab === "connectors" && <FlowConnectorsTab packageId={packageId} />}
      {type === "flow" && tab === "executions" && (
        <FlowExecutionsTab
          packageId={packageId}
          resolvedVersion={resolvedVersion}
          configSchemaOverride={isHistoricalVersion ? effectiveConfigSchema : undefined}
        />
      )}
      {type === "flow" && tab === "schedules" && <FlowSchedulesTab packageId={packageId} />}
      {type === "flow" && tab === "memories" && (
        <FlowMemoriesTab packageId={packageId} isOrgAdmin={isOrgAdmin} />
      )}
      {type === "flow" && tab === "api" && (
        <FlowApiTab packageId={packageId} isOrgAdmin={isOrgAdmin} />
      )}

      {type !== "flow" && tab === "content" && pkgDetail && (
        <div className="rounded-lg border border-border bg-card p-4">
          {type === "provider" && providerConfig && (
            <div className="flex items-center gap-2 mb-4 pb-4 border-b border-border">
              <span className="text-sm text-muted-foreground">
                {t("providers.credentials", { ns: "settings" })}:
              </span>
              {providerConfig.enabled ? (
                <span className="inline-flex items-center rounded-full bg-emerald-500/10 text-emerald-500 text-xs font-medium px-2 py-0.5">
                  {t("providers.configured", { ns: "settings" })}
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full bg-warning/10 text-warning text-xs font-medium px-2 py-0.5">
                  {t("providers.notConfigured", { ns: "settings" })}
                </span>
              )}
            </div>
          )}
          <pre className="whitespace-pre-wrap text-xs font-mono text-muted-foreground bg-muted/50 rounded-md p-3 overflow-x-auto">
            {type === "provider"
              ? JSON.stringify(
                  (isHistoricalVersion && versionDetail?.manifest
                    ? versionDetail.manifest
                    : pkgDetail.manifest) ?? {},
                  null,
                  2,
                )
              : isHistoricalVersion && versionDetail?.content != null
                ? versionDetail.content
                : pkgDetail.content}
          </pre>
        </div>
      )}

      {type !== "flow" && tab === "usedBy" && pkgDetail && (
        <div className="rounded-lg border border-border bg-card p-4">
          {pkgDetail.flows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {t("packages.noFlows")}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {pkgDetail.flows.map((f) => (
                <Link
                  key={f.id}
                  to={`/flows/${f.id}`}
                  className="inline-flex items-center rounded-md border border-border px-2.5 py-1 text-sm hover:border-primary transition-colors no-underline text-foreground"
                >
                  {f.displayName || f.id}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "versions" && (
        <VersionHistory packageId={packageId} type={type} isAdmin={isOrgAdmin} isOwned={isOwned} />
      )}

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
                language={type === "flow" ? "markdown" : undefined}
              />
            )}
          {!hasManifestChanges && !hasContentChanges && (
            <p className="text-sm text-muted-foreground py-4 text-center">{t("version.noDiff")}</p>
          )}
        </>
      )}
      {tab === "changes" && hasDraftChanges && !isVersionView && !latestVersionForDiff && (
        <p className="text-sm text-muted-foreground py-4 text-center">
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
      {type === "flow" && <FlowModals packageId={packageId} />}

      {/* Provider credentials modal */}
      {type === "provider" && providerConfig && credentialsOpen && (
        <ProviderCredentialsModal
          provider={providerConfig}
          callbackUrl={callbackUrl}
          onClose={() => setCredentialsOpen(false)}
        />
      )}
    </>
  );
}
