// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";
import { Database, Layers, LayoutGrid, Play, Settings2, TriangleAlert } from "lucide-react";
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
import { catalogueVersionFor } from "../lib/catalogue-link";
import { packageDetailPath } from "../lib/package-paths";
import { TOOLBAR_ACTION } from "../lib/toolbar-button";

// Shared components
import { PackageDetailBar } from "../components/package-detail/package-detail-bar";
import { PackageDetailSkeleton } from "../components/loading-skeletons";
import { PackageActionsDropdown } from "../components/package-detail/package-actions-dropdown";
import { CatalogueLink } from "../components/package-detail/catalogue-link";
import { VersionBanners } from "../components/version-banners";
import { PackageOverview } from "../components/package-detail/package-overview";
import { isOwnedSource } from "../components/package-detail/owned-source";
import { PackageOwnershipNotice } from "../components/package-detail/package-ownership";
import { CreateVersionModal } from "../components/create-version-modal";
// Agent-specific components
import { AgentActions } from "../components/package-detail/agent-actions";
import { AgentRunsTab, AgentMemoryTab } from "../components/package-detail/agent-tabs";
import { AgentInactiveAlert } from "../components/package-detail/agent-inactive-alert";
import { AgentOverviewTab } from "../components/agent-detail/agent-overview-tab";
import { AgentIdentity } from "../components/agent-detail/agent-identity";
import { AgentDetailBar } from "../components/agent-detail/agent-detail-bar";
import { AgentSettingsView } from "../components/agent-detail/agent-settings-view";
import { DetailTabs, DetailTabPanel, type DetailTab } from "../components/detail-tabs";
import { AgentRunButton } from "../components/package-detail/agent-run-button";
import { PackageUsage } from "../components/package-detail/package-usage";
import { PackageSettingsView } from "../components/package-detail/package-settings-view";
import { RoleLimitNotice } from "../components/role-limit-notice";
import { useAgentModelBlocker } from "../hooks/use-agent-readiness";
import { EditorDirtyReportContext } from "../hooks/use-editor-state";

type PackageTab = "overview" | "runs" | "settings" | "memory" | "usedBy";

type TabSpec = {
  value: PackageTab;
  labelKey: string;
  icon: NonNullable<DetailTab<PackageTab>["icon"]>;
};

const AGENT_TABS: TabSpec[] = [
  { value: "overview", labelKey: "detail.overview.summary", icon: LayoutGrid },
  { value: "runs", labelKey: "detail.tabRuns", icon: Play },
  { value: "memory", labelKey: "detail.tabMemory", icon: Database },
  { value: "settings", labelKey: "detail.tabSettings", icon: Settings2 },
];

const PACKAGE_TABS: TabSpec[] = [
  { value: "overview", labelKey: "detail.overview.summary", icon: LayoutGrid },
  { value: "settings", labelKey: "detail.tabSettings", icon: Settings2 },
  { value: "usedBy", labelKey: "packages.usedBy", icon: Layers },
];

const EMPTY_INPUT_WRAPPER: SchemaWrapper = { schema: { type: "object", properties: {} } };

const MODEL_ALERT_COPY = {
  "detail.titleModel": {
    title: "models.alert.noModel",
    description: "models.alert.noModelDescription",
    askAdmin: "models.alert.noModelAskAdmin",
  },
  "detail.titleNoDefaultModel": {
    title: "models.alert.noDefaultModel",
    description: "models.alert.noDefaultModelDescription",
    askAdmin: "models.alert.noDefaultModelAskAdmin",
  },
} as const;

function stringOr<T>(value: unknown, fallback: T): string | T {
  return typeof value === "string" ? value : fallback;
}

/** No model a run could use: said where it can be acted on, graded by who may act. */
function ModelRequiredAlert({ blocker }: { blocker: ReturnType<typeof useAgentModelBlocker> }) {
  const { t } = useTranslation(["settings"]);
  const { can } = usePermissions();

  const copy = blocker && MODEL_ALERT_COPY[blocker];
  if (!copy) return null;

  return (
    <Alert variant="destructive" className="mb-4">
      <TriangleAlert className="h-4 w-4" />
      <AlertTitle>{t(copy.title)}</AlertTitle>
      {/* Only `models:write` can act on it (POST /api/models, PUT /api/models/default). */}
      <AlertDescription>
        {t(can("models:write") ? copy.description : copy.askAdmin)}
      </AlertDescription>
    </Alert>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────

export function UnifiedPackageDetailPage({ type }: { type: PackageType }) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  const { can } = usePermissions();
  // Only an agent has a narrower read: without `agents:read` a runner launches
  // it and follows its own runs, but does not see what it is made of.
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
  // The model verdict alone: it holds whatever else blocks the run first. Read
  // here, beside the detail, so the alert does not wait for the loading gate.
  const modelBlocker = useAgentModelBlocker(type === "agent" ? packageId : undefined);

  // Type-narrowed aliases for type-specific branches
  const agentDetail = type === "agent" ? (detail as Versioned<AgentDetail> | undefined) : undefined;
  const pkgDetail =
    type !== "agent" ? (detail as Versioned<OrgPackageItemDetail> | undefined) : undefined;

  const base = agentDetail ?? pkgDetail;
  const displayName = agentDetail?.display_name ?? pkgDetail?.name ?? pkgDetail?.id ?? "";
  const source = base?.source;
  // Which definition (draft or published) the server projected, for every type.
  const definition = base?.definition;
  const version = base?.version;
  const hasUnarchivedChanges = base?.has_unarchived_changes;
  const forkedFrom = base?.forked_from ?? null;
  const isOwned = isOwnedSource(source);

  const versionQuery = useVersionDetail(type, packageId, versionParam);
  const { data: versionDetail, error: versionError } = versionQuery;
  const versionLoading = isQueryInFlight(versionQuery);

  // The server's flag gates publishing (it sees annexes the manifest/prompt
  // comparison below cannot); the comparison only decides whether a diff has content.
  const hasTimestampChanges = source !== "system" && !!hasUnarchivedChanges;
  const latestDiffQuery = useVersionDetail(
    type,
    packageId,
    hasTimestampChanges ? "latest" : undefined,
  );
  const { data: latestVersionForDiff } = latestDiffQuery;
  // The header names the draft only once this has settled, or « Brouillon » would flash.
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
  // Skill and MCP-server details carry no `active`; an agent's does, so the query is not mounted there.
  const { isActiveInCurrentSpace } = usePackageActivationState(packageId, {
    enabled: type !== "agent",
  });
  // The detail response is the authority on the home contract; `undefined` (not loaded) reads as "no".
  const homeSpaceId = base?.home_space_id;
  const homeWritable = base?.home_writable;
  const homeDeletable = base?.home_deletable;
  const homeSpaceName = useHomeSpaceName(homeSpaceId);

  // ── State ──
  // `useTabWithHash` falls back to the default tab for any hash outside this list. An agent's
  // tabs are the same for every role: a tab whose read is missing says so in its panel.
  const tabs = type === "agent" ? AGENT_TABS : PACKAGE_TABS;
  const allValidTabs = tabs.map((entry) => entry.value);
  // An agent the reader may only run opens on its runs when that role reads them.
  const defaultTab: PackageTab = !fullRead && tabReads.runs ? "runs" : "overview";
  const [tab, setTab] = useTabWithHash<PackageTab>(allValidTabs, defaultTab);
  const [creatingVersion, setCreatingVersion] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  // ── Loading / Error ──
  if (isQueryInFlight(detailQuery) || (isVersionView && versionLoading))
    return <PackageDetailSkeleton type={type} />;
  if (error || !detail) return <ResourceErrorState error={error} />;

  // A published version whose stored archive is unavailable EXISTS — redirecting
  // to the live page (what any other version failure does) would hide that it
  // is broken. Say so, and leave the way back to the live page one click away.
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

  // The manifest the page is looking at — the archived one when a version is
  // pinned, the live draft otherwise. Same rule the file explorer follows.
  const effectiveManifest = isHistoricalVersion ? versionDetail?.manifest : currentManifest;

  // A pinned version shows its OWN parameter schema; one it does not declare
  // is an empty wrapper, never the draft's.
  const historicalInputWrapper = isHistoricalVersion
    ? ((versionDetail?.manifest?.input as SchemaWrapper | undefined) ?? EMPTY_INPUT_WRAPPER)
    : undefined;

  const downloadVersion = (isHistoricalVersion ? versionDetail?.version : version) ?? undefined;

  // ── Unified detail for the header and the overview ──
  const historicalManifestName = stringOr(versionDetail?.manifest?.display_name, packageId);
  const historicalManifestDescription = stringOr(versionDetail?.manifest?.description, "");
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
    icon: type === "agent" ? agentDetail?.icon : stringOr(pkgDetail?.manifest?.icon, undefined),
    color: type === "agent" ? agentDetail?.color : undefined,
    readsPublished: type === "agent" && agentDetail?.definition === "published",
    homeSpaceName,
  };

  // ── Render ──
  const isBuiltIn = source === "system";

  const tabDefs: DetailTab<PackageTab>[] = tabs.map(({ value, labelKey, icon }) => ({
    value,
    label: t(labelKey),
    icon,
  }));

  // The trigger's own verdict, which also bounds the dialog.
  const canCreateVersion = !!homeWritable && !isBuiltIn && !isHistoricalVersion && isOwned;
  // Publishing or running reads the stored draft, not the edits held on screen.
  const unsavedReason = editorDirty ? t("detail.unsavedBlocksAction") : undefined;

  // Versions live in Paramètres › Explorer for every type.
  const versionsProps = {
    // Restoring writes the draft, deleting removes a version: both are judged
    // in the package's HOME space, never in the space being browsed.
    canRestore: !isBuiltIn && !!homeWritable,
    canDelete: !isBuiltIn && !!homeDeletable,
    // The page's « Créer une version » (PackageActionsDropdown's `isMutable`).
    onCreate: canCreateVersion ? () => setCreatingVersion(true) : undefined,
    hasUnarchivedChanges: hasArchivableChanges && !isVersionView,
  };

  const versionLabel = isHistoricalVersion ? versionDetail?.version : undefined;

  // The sheet opens on the version the reader chose, and follows the current one otherwise.
  const catalogueLink = (
    <CatalogueLink
      type={type}
      packageId={packageId}
      version={catalogueVersionFor({
        isHistoricalVersion,
        source,
        version: versionDetail?.version,
      })}
    />
  );

  const runButton = (
    // The page's one launch verdict, shared with the empty runs list.
    <AgentRunButton
      packageId={packageId}
      versionLabel={versionLabel}
      variant="outline"
      size="sm"
      className={TOOLBAR_ACTION}
      unsavedReason={unsavedReason}
    />
  );

  return (
    <EditorDirtyReportContext.Provider value={setEditorDirty}>
      {/* The tabs root wraps the whole page, header included: an agent's tab bar
          is portalled into the shell header and must still answer these tabs. */}
      <DetailTabs value={tab} onChange={setTab}>
        {type === "agent" ? (
          <AgentDetailBar
            title={unifiedForHeader.displayName}
            detail={unifiedForHeader}
            isHistoricalVersion={isHistoricalVersion}
            draftVerdictPending={draftVerdictPending}
            hasUnarchivedChanges={!!hasArchivableChanges}
            latestPublishedVersion={versionInfo?.latest_published_version}
            tabs={tabDefs}
            actions={
              <>
                {catalogueLink}
                {runButton}
                <AgentActions
                  packageId={packageId}
                  isHistoricalVersion={isHistoricalVersion}
                  downloadVersion={downloadVersion}
                  downloadPackage={downloadPackage}
                  downloadBundle={downloadBundle}
                  onCreateVersion={() => setCreatingVersion(true)}
                  unsavedReason={unsavedReason}
                />
              </>
            }
          />
        ) : (
          <PackageDetailBar
            detail={unifiedForHeader}
            isHistoricalVersion={isHistoricalVersion}
            // For a package the server's flag is authoring state: only whoever can
            // publish the draft has a use for it.
            hasUnarchivedChanges={hasTimestampChanges && !!homeWritable}
            tabs={tabDefs}
            actions={
              <>
                {catalogueLink}
                <PackageActionsDropdown
                  packageId={packageId}
                  type={type}
                  detail={pkgDetail}
                  isHistoricalVersion={isHistoricalVersion}
                  downloadVersion={downloadVersion}
                  onDownload={downloadPackage}
                  onCreateVersion={() => setCreatingVersion(true)}
                  createVersionBlockedReason={unsavedReason}
                  isActiveHere={isActiveInCurrentSpace}
                />
              </>
            }
          />
        )}

        <VersionBanners
          isHistorical={isHistoricalVersion}
          versionDetail={versionDetail}
          activeUrl={packageDetailPath(type, packageId)}
        />

        {type === "agent" && <ModelRequiredAlert blocker={modelBlocker} />}

        {/* Placed here, switched off. The page renders in full — reading and
          configuring an agent is not running it — and says the one thing that
          would otherwise turn a click into a 404. */}
        {agentDetail && !agentDetail.active && <AgentInactiveAlert packageId={packageId} />}

        {/* Nothing published and the working copy is not this reader's: says why Run is greyed out. */}
        <PackageOwnershipNotice
          type={type}
          isOwned={isOwned}
          forkedFrom={forkedFrom}
          draftReadOnly={definition === "draft" && !homeWritable}
        />

        {type === "agent" && agentDetail && (
          <>
            <DetailTabPanel value="overview">
              <div className="flex flex-col gap-8">
                <AgentIdentity
                  description={unifiedForHeader.description}
                  source={unifiedForHeader.source}
                  homeSpaceName={homeSpaceName}
                />
                {fullRead ? (
                  <AgentOverviewTab
                    packageId={packageId}
                    detail={agentDetail}
                    isHistorical={isHistoricalVersion}
                  />
                ) : (
                  // Without `agents:read` the summary's fields (manifest, prompt,
                  // authoring history) are not served: say what the role allows.
                  <div className="flex flex-col gap-4">
                    <RoleLimitNotice>{t("detail.roleLimit.overview")}</RoleLimitNotice>
                    {tabReads.runs && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="self-start"
                        onClick={() => setTab("runs")}
                      >
                        {t("detail.roleLimit.seeRuns")}
                      </Button>
                    )}
                  </div>
                )}
              </div>
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
          </>
        )}

        {type !== "agent" && (
          <>
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
          </>
        )}

        {/* Mounted only while open: any way of closing a form modal abandons its input. */}
        {creatingVersion && canCreateVersion && (
          <CreateVersionModal
            onClose={() => setCreatingVersion(false)}
            type={type}
            packageId={packageId}
            hasUnarchivedChanges={hasTimestampChanges}
            etag={base?.etag}
          />
        )}
      </DetailTabs>
    </EditorDirtyReportContext.Provider>
  );
}
