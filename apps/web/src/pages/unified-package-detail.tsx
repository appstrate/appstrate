// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";
import { TriangleAlert } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import {
  usePackageDetail,
  useVersionDetail,
  useAgentBundleExport,
  usePackageDownload,
  useVersionInfo,
  type Versioned,
} from "../hooks/use-packages";
import type { AgentDetail, OrgPackageItemDetail, PackageType } from "@appstrate/shared-types";
import { useHomeSpaceName } from "../hooks/use-permissions";
import { canReadRuns, packageSightPermissions } from "@appstrate/core/permissions";
import type { SchemaWrapper } from "@appstrate/core/form";
import { usePackageActivationState } from "../hooks/use-library";
import { EmptyState, ResourceErrorState } from "../components/page-states";
import { ApiError } from "../api/client";
import { getVersionRedirect, hasActualChanges } from "../lib/version-helpers";
import { isQueryInFlight } from "../lib/query-state";
import { packageDetailPath } from "../lib/package-paths";

// Shared components
import { SharedHeader } from "../components/package-detail/shared-header";
import { PackageDetailSkeleton } from "../components/loading-skeletons";
import { PackageActionsDropdown } from "../components/package-detail/package-actions-dropdown";
import { VersionBanners } from "../components/version-banners";
import { PackageOverview } from "../components/package-detail/package-overview";
import { isOwnedSource } from "../components/package-detail/owned-source";
import { PackageOwnershipNotice } from "../components/package-detail/package-ownership";
import { useModalParam } from "../hooks/use-modal-param";
import { CreateVersionModal } from "../components/create-version-modal";
// Agent-specific components
import { AgentActions } from "../components/package-detail/agent-actions";
import { AgentRunsTab, AgentMemoryTab } from "../components/package-detail/agent-tabs";
import { AgentInactiveAlert } from "../components/package-detail/agent-inactive-alert";
import { AgentOverviewTab } from "../components/agent-detail/agent-overview-tab";
import { AgentSettingsView } from "../components/agent-detail/agent-settings-view";
import {
  DetailTabs,
  DetailTabBar,
  DetailTabPanel,
  type DetailTab,
} from "../components/detail-tabs";
import { AgentRunButton } from "../components/package-detail/agent-run-button";
import { PackageUsage } from "../components/package-detail/package-usage";
import { PackageSettingsView } from "../components/package-detail/package-settings-view";
import { RoleLimitNotice } from "../components/role-limit-notice";
import { useAgentModelBlocker } from "../hooks/use-agent-readiness";
import { EditorDirtyReportContext } from "../hooks/use-editor-state";

type PackageTab = "overview" | "runs" | "settings" | "memory" | "usedBy";

const AGENT_DETAIL_TABS = ["overview", "runs", "memory", "settings"] as const;

const EMPTY_INPUT_WRAPPER: SchemaWrapper = { schema: { type: "object", properties: {} } };

/** No model a run could use: said where it can be acted on, graded by who may act. */
function ModelRequiredAlert({ blocker }: { blocker: ReturnType<typeof useAgentModelBlocker> }) {
  const { t } = useTranslation(["settings"]);
  const { can } = usePermissions();

  const copy =
    blocker === "detail.titleModel"
      ? {
          title: t("models.alert.noModel"),
          // Only `models:write` can act on "configure a model" (POST /api/models).
          description: t(
            can("models:write")
              ? "models.alert.noModelDescription"
              : "models.alert.noModelAskAdmin",
          ),
        }
      : blocker === "detail.titleNoDefaultModel"
        ? {
            title: t("models.alert.noDefaultModel"),
            // Only `models:write` can set the default (PUT /api/models/default).
            description: t(
              can("models:write")
                ? "models.alert.noDefaultModelDescription"
                : "models.alert.noDefaultModelAskAdmin",
            ),
          }
        : null;
  if (!copy) return null;

  return (
    <Alert variant="destructive" className="mb-4">
      <TriangleAlert className="size-4" />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription className="flex items-center justify-between">
        <span>{copy.description}</span>
      </AlertDescription>
    </Alert>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────

export function UnifiedPackageDetailPage({ type }: { type: PackageType }) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  const { can } = usePermissions();
  // Without `agents:read` a runner launches an agent and follows its runs but does not see what it is made of.
  const fullRead = type !== "agent" || can("agents:read");
  const {
    scope,
    name,
    version: versionParam,
  } = useParams<{ scope: string; name: string; version?: string }>();
  const packageId = `${scope}/${name}`;
  // Each tab below is fed by a read of its own, none implied by this route.
  const tabReads = {
    runs: canReadRuns(can),
    memory: can("persistence:read"),
    usedBy: packageSightPermissions("agent").some(can),
  };
  const isVersionView = !!versionParam;

  // ── Data loading (unified) ──
  const detailQuery = usePackageDetail(type, packageId);
  const { data: detail, error } = detailQuery;
  const { data: versionInfo } = useVersionInfo(type, type === "agent" ? packageId : undefined);
  // Read beside the detail so the alert does not wait for the loading gate.
  const modelBlocker = useAgentModelBlocker(type === "agent" ? packageId : undefined);

  const agentDetail = type === "agent" ? (detail as Versioned<AgentDetail> | undefined) : undefined;
  const pkgDetail =
    type !== "agent" ? (detail as Versioned<OrgPackageItemDetail> | undefined) : undefined;

  const displayName = agentDetail?.display_name ?? pkgDetail?.name ?? pkgDetail?.id ?? "";
  const source = agentDetail?.source ?? pkgDetail?.source;
  // WHICH definition the server projected (draft or published), the same for every type.
  const definition = (agentDetail ?? pkgDetail)?.definition;
  const version = agentDetail?.version ?? pkgDetail?.version;
  const hasUnarchivedChanges =
    agentDetail?.has_unarchived_changes ?? pkgDetail?.has_unarchived_changes;
  const forkedFrom = agentDetail?.forked_from ?? pkgDetail?.forked_from ?? null;
  const isOwned = isOwnedSource(source);

  const versionQuery = useVersionDetail(type, packageId, versionParam);
  const { data: versionDetail, error: versionError } = versionQuery;
  const versionLoading = isQueryInFlight(versionQuery);

  // The server's flag gates publishing (it sees annexes the comparison below cannot, and answers
  // `409 no_changes`); the comparison only decides whether a diff tab has anything to show.
  const hasTimestampChanges = source !== "system" && !!hasUnarchivedChanges;
  const latestDiffQuery = useVersionDetail(
    type,
    packageId,
    hasTimestampChanges ? "latest" : undefined,
  );
  const { data: latestVersionForDiff } = latestDiffQuery;
  // An agent's header names its draft only once this comparison has settled:
  // answering before it would show « Brouillon » and then swap it for the version.
  const draftVerdictPending = type === "agent" && isQueryInFlight(latestDiffQuery);
  // Refine: once we have the latest version data, check for real content diff
  const currentManifest = type === "agent" ? agentDetail?.manifest : pkgDetail?.manifest;
  const currentContent = agentDetail?.prompt ?? pkgDetail?.content;
  const hasArchivableChanges =
    hasTimestampChanges &&
    (!latestVersionForDiff ||
      hasActualChanges(latestVersionForDiff, currentManifest, currentContent));

  const downloadPackage = usePackageDownload(scope, name);
  const downloadBundle = useAgentBundleExport(scope, name);
  // Skills and MCP servers only: their detail carries no `active`. An agent's detail answers for itself (`AgentDetail.active`), so the query is not mounted there.
  const { isActiveInCurrentSpace } = usePackageActivationState(packageId, {
    enabled: type !== "agent",
  });
  // The detail response is the authority on the home contract; `undefined` (not loaded) reads as "no".
  const homeSpaceId = (agentDetail ?? pkgDetail)?.home_space_id;
  const homeWritable = (agentDetail ?? pkgDetail)?.home_writable;
  const homeDeletable = (agentDetail ?? pkgDetail)?.home_deletable;
  const homeSpaceName = useHomeSpaceName(homeSpaceId);

  // ── State ──
  // The tabs this caller may MOUNT (`useTabWithHash` falls back for anything outside the list).
  // An agent's tabs are the same for every role; a tab the caller cannot read says so (`RoleLimitNotice`).
  const allValidTabs: readonly PackageTab[] =
    type === "agent" ? AGENT_DETAIL_TABS : ["overview", "settings", "usedBy"];
  // Every detail opens on its summary; an agent the reader may only run opens on
  // its runs when that role reads them.
  const defaultTab: PackageTab = !fullRead && tabReads.runs ? "runs" : "overview";
  const [tab, setTab] = useTabWithHash<PackageTab>(allValidTabs, defaultTab);
  const newVersion = useModalParam("newVersion");
  const [editorDirty, setEditorDirty] = useState(false);
  // ── Loading / Error ──
  if (isQueryInFlight(detailQuery) || (isVersionView && versionLoading))
    return <PackageDetailSkeleton type={type} />;
  if (error || !detail) return <ResourceErrorState error={error} />;

  // A version with an unavailable archive EXISTS: redirecting (as other version failures do) would hide that it is broken.
  if (
    isVersionView &&
    versionError instanceof ApiError &&
    versionError.code === "version_artifact_unavailable"
  ) {
    return (
      <EmptyState
        message={t("error.generic", { ns: "common" })}
        hint={t("files.errorMissingArtifact")}
        icon={TriangleAlert}
        tone="danger"
      >
        <Button asChild variant="outline" size="sm">
          <Link to={packageDetailPath(type, packageId)}>{t("btn.back", { ns: "common" })}</Link>
        </Button>
      </EmptyState>
    );
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

  // The manifest on screen: the archived one when a version is pinned, else the live draft.
  const effectiveManifest = isHistoricalVersion ? versionDetail?.manifest : currentManifest;

  // A pinned version shows its OWN parameter schema; one it does not declare
  // is an empty wrapper, never the draft's.
  const historicalInputWrapper = isHistoricalVersion
    ? ((versionDetail?.manifest?.input as SchemaWrapper | undefined) ?? EMPTY_INPUT_WRAPPER)
    : undefined;

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
    // The header names the version on screen, not the live one behind it.
    version: downloadVersion,
    icon:
      type === "agent"
        ? agentDetail?.icon
        : typeof pkgDetail?.manifest?.icon === "string"
          ? pkgDetail.manifest.icon
          : undefined,
    color: type === "agent" ? agentDetail?.color : undefined,
    readsPublished: type === "agent" && agentDetail?.definition === "published",
    homeSpaceName,
  };

  // ── Render ──
  const isBuiltIn = source === "system";

  // Determine available tabs based on type

  // The rendered manifest, next to the raw artifact it comes from.
  const overviewTab: DetailTab<PackageTab> = {
    value: "overview",
    label: t("detail.overview.summary"),
  };

  const agentTabLabels: Record<(typeof AGENT_DETAIL_TABS)[number], string> = {
    overview: t("detail.overview.summary"),
    runs: t("detail.tabRuns"),
    memory: t("detail.tabMemory"),
    settings: t("detail.tabSettings"),
  };
  const agentTabs: Array<DetailTab<PackageTab>> = AGENT_DETAIL_TABS.map((value) => ({
    value,
    label: agentTabLabels[value],
  }));

  const pkgTabs: Array<DetailTab<PackageTab>> = [
    overviewTab,
    { value: "settings", label: t("detail.tabSettings") },
    { value: "usedBy", label: t("packages.usedBy") },
  ];

  const tabDefs = type === "agent" ? agentTabs : pkgTabs;

  // The trigger's own verdict, which also bounds its `?newVersion` URL.
  const canCreateVersion = !!homeWritable && !isBuiltIn && !isHistoricalVersion && isOwned;
  // Publishing or running reads the stored draft, not the edits held on screen.
  const unsavedReason = editorDirty ? t("detail.unsavedBlocksAction") : undefined;

  // Versions live in Paramètres › Explorer for every type.
  const versionsProps = {
    // Judged in the package's HOME space, never the space being browsed.
    canRestore: !isBuiltIn && !!homeWritable,
    canDelete: !isBuiltIn && !!homeDeletable,
    // The page's « Créer une version » (PackageActionsDropdown's `isMutable`).
    onCreate: canCreateVersion ? () => newVersion.open() : undefined,
    hasUnarchivedChanges: hasArchivableChanges && !isVersionView,
  };

  const versionLabel = isHistoricalVersion ? versionDetail?.version : undefined;

  return (
    <EditorDirtyReportContext.Provider value={setEditorDirty}>
      <div>
        <SharedHeader
          detail={unifiedForHeader}
          isHistoricalVersion={isHistoricalVersion}
          // A package's draft is authoring state (publishers only); an agent's header names it to any reader, when it differs from the last version.
          draftVerdictPending={draftVerdictPending}
          hasUnarchivedChanges={
            type === "agent" ? hasArchivableChanges : hasTimestampChanges && !!homeWritable
          }
          latestPublishedVersion={versionInfo?.latest_published_version}
          activeSubpage={{
            label: tabDefs.find((item) => item.value === tab)?.label ?? overviewTab.label,
          }}
          actionsLeft={
            type === "agent" ? (
              // The page's one launch verdict, shared with the empty runs list.
              <AgentRunButton
                packageId={packageId}
                versionLabel={versionLabel}
                variant="outline"
                size="sm"
                className="bg-card"
                unsavedReason={unsavedReason}
              />
            ) : undefined
          }
          actionsRight={
            type === "agent" ? (
              <AgentActions
                packageId={packageId}
                isHistoricalVersion={isHistoricalVersion}
                downloadVersion={downloadVersion}
                downloadPackage={downloadPackage}
                downloadBundle={downloadBundle}
                onCreateVersion={() => newVersion.open()}
                unsavedReason={unsavedReason}
              />
            ) : (
              <div className="flex items-center gap-2">
                <PackageActionsDropdown
                  packageId={packageId}
                  type={type}
                  detail={pkgDetail}
                  isHistoricalVersion={isHistoricalVersion}
                  downloadVersion={downloadVersion}
                  onDownload={downloadPackage}
                  onCreateVersion={() => newVersion.open()}
                  createVersionBlockedReason={unsavedReason}
                  isActiveHere={isActiveInCurrentSpace}
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

        {type === "agent" && <ModelRequiredAlert blocker={modelBlocker} />}

        {agentDetail && !agentDetail.active && <AgentInactiveAlert packageId={packageId} />}

        {/* Unpublished and not this reader's working copy: says why Run is greyed out. */}
        <PackageOwnershipNotice
          type={type}
          isOwned={isOwned}
          forkedFrom={forkedFrom}
          draftReadOnly={definition === "draft" && !homeWritable}
        />

        {type === "agent" && agentDetail && (
          <div className="overflow-visible" data-agent-detail-surface>
            <DetailTabs value={tab} onChange={setTab}>
              <DetailTabBar tabs={agentTabs} />

              <DetailTabPanel value="overview">
                {fullRead ? (
                  <AgentOverviewTab
                    packageId={packageId}
                    detail={agentDetail}
                    isHistorical={isHistoricalVersion}
                  />
                ) : (
                  // Without `agents:read` the summary's fields (manifest, prompt,
                  // authoring history) are not served: say what the role allows.
                  <div className="space-y-4">
                    <RoleLimitNotice>{t("detail.roleLimit.overview")}</RoleLimitNotice>
                    {tabReads.runs && (
                      <Button variant="outline" size="sm" onClick={() => setTab("runs")}>
                        {t("detail.roleLimit.seeRuns")}
                      </Button>
                    )}
                  </div>
                )}
              </DetailTabPanel>
              <DetailTabPanel value="runs">
                {tabReads.runs ? (
                  <AgentRunsTab packageId={packageId} versionLabel={versionLabel} />
                ) : (
                  <RoleLimitNotice>{t("detail.roleLimit.runs")}</RoleLimitNotice>
                )}
              </DetailTabPanel>
              <DetailTabPanel value="settings" flush>
                <AgentSettingsView
                  versions={versionsProps}
                  packageId={packageId}
                  detail={agentDetail}
                  version={versionLabel}
                  isHistorical={isHistoricalVersion}
                  inputWrapperOverride={historicalInputWrapper}
                />
              </DetailTabPanel>
              <DetailTabPanel value="memory" flush>
                {tabReads.memory ? (
                  <AgentMemoryTab packageId={packageId} />
                ) : (
                  <RoleLimitNotice className="m-6">{t("detail.roleLimit.memory")}</RoleLimitNotice>
                )}
              </DetailTabPanel>
            </DetailTabs>
          </div>
        )}

        {type !== "agent" && (
          <DetailTabs value={tab} onChange={setTab}>
            <DetailTabBar tabs={tabDefs} />
            {/* Non-Agent tab content */}
            {/* Both follow the version being viewed: the explorer through
          `versionLabel`, the overview through the manifest picked above. */}
            <DetailTabPanel value="overview">
              {pkgDetail && (
                <PackageOverview
                  type={type}
                  description={unifiedForHeader.description}
                  content={isHistoricalVersion ? versionDetail?.content : pkgDetail.content}
                  manifest={effectiveManifest}
                  version={unifiedForHeader.version}
                  historical={isHistoricalVersion}
                  agentCount={pkgDetail.agents.length}
                  onOpenFiles={() => setTab("settings")}
                  onOpenUsage={() => setTab("usedBy")}
                />
              )}
            </DetailTabPanel>

            {(type === "skill" || type === "mcp-server") && (
              <DetailTabPanel value="settings" flush>
                <PackageSettingsView
                  versions={versionsProps}
                  type={type}
                  packageId={packageId}
                  detail={pkgDetail}
                  version={versionLabel}
                />
              </DetailTabPanel>
            )}

            <DetailTabPanel value="usedBy">
              {!tabReads.usedBy ? (
                <RoleLimitNotice>{t("detail.roleLimit.usedBy")}</RoleLimitNotice>
              ) : (
                pkgDetail && <PackageUsage agentIds={pkgDetail.agents.map((agent) => agent.id)} />
              )}
            </DetailTabPanel>
          </DetailTabs>
        )}

        {/* Mounted only while open: any way of closing a form modal abandons its input. */}
        {newVersion.value !== null && canCreateVersion && (
          <CreateVersionModal
            onClose={newVersion.close}
            type={type}
            packageId={packageId}
            hasUnarchivedChanges={hasTimestampChanges}
            etag={(agentDetail ?? pkgDetail)?.etag}
          />
        )}
      </div>
    </EditorDirtyReportContext.Provider>
  );
}
