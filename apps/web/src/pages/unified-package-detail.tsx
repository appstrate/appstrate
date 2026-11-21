// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
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
  useAgentsAmong,
  type Versioned,
} from "../hooks/use-packages";
import type { AgentDetail, OrgPackageItemDetail } from "@appstrate/shared-types";
import { useHomeSpaceName } from "../hooks/use-permissions";
import {
  canReadRuns,
  packagePermission,
  packageSightPermissions,
} from "@appstrate/core/permissions";
import type { SchemaWrapper } from "@appstrate/core/form";
import { EmptyState } from "../components/page-states";
import { UnreadableDetail } from "../components/unreadable-detail";
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
import { VersionBanners } from "../components/version-banners";
import { PackageOverview } from "../components/package-detail/package-overview";
import { isOwnedSource } from "../components/package-detail/owned-source";
import { PackageOwnershipNotice } from "../components/package-detail/package-ownership";
import { AvailabilityBadge } from "../components/package-detail/availability-card";
import { CreateVersionModal } from "../components/create-version-modal";
// Agent-specific components
import { AgentActions } from "../components/package-detail/agent-actions";
import { AgentRunsTab, AgentMemoryTab } from "../components/package-detail/agent-tabs";
import { AgentInactiveAlert } from "../components/package-detail/agent-inactive-alert";
import { AgentOverviewTab } from "../components/agent-detail/agent-overview-tab";
import { AgentDetailBar } from "../components/agent-detail/agent-detail-bar";
import { AgentSettingsView } from "../components/agent-detail/agent-settings-view";
import { DetailTabs, DetailTabPanel, type DetailTab } from "../components/detail-tabs";
import { AgentRunButton } from "../components/package-detail/agent-run-button";
import { PackageUsage } from "../components/package-detail/package-usage";
import { PackageSettingsView } from "../components/package-detail/package-settings-view";
import { RoleLimitNotice } from "../components/role-limit-notice";
import { useAgentModelBlocker } from "../hooks/use-agent-readiness";
import { useAdmittingSpaces, useOverviewMode } from "../hooks/use-overview-mode";
import { useSpacesFor } from "../hooks/use-space-action";
import { ModelRequiredAlert } from "../components/agent-detail/model-required-alert";
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

function stringOr<T>(value: unknown, fallback: T): string | T {
  return typeof value === "string" ? value : fallback;
}

// ─── Main Page ──────────────────────────────────────────────────────

/** One body per package and version: the modals it opens hold that package's state, and a route change must not carry them to another. */
export function UnifiedPackageDetailPage({ type }: { type: "agent" | "skill" }) {
  const { scope, name, version } = useParams<{ scope: string; name: string; version?: string }>();
  return <PackageDetailBody key={`${scope}/${name}@${version ?? ""}`} type={type} />;
}

function PackageDetailBody({ type }: { type: "agent" | "skill" }) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  const { can } = usePermissions();
  const {
    scope,
    name,
    version: versionParam,
  } = useParams<{ scope: string; name: string; version?: string }>();
  const packageId = `${scope}/${name}`;
  const isVersionView = !!versionParam;

  // ── Data loading (unified) ──
  const detailQuery = usePackageDetail(type, packageId);
  const { data: detail, error } = detailQuery;

  // Each tab below is fed by a read of its own, none implied by this route. In « Tous les
  // espaces » a tab listing rows across spaces opens where some space admits its list (runs,
  // agents) or grants its read (memory); the agent's own content where a readable placement grants full access.
  const { on: overview } = useOverviewMode();
  const runSpaces = useAdmittingSpaces("runs");
  const agentSpaces = useAdmittingSpaces("agents");
  const memoryReach = useSpacesFor({ permission: "persistence:read" });
  const agentReach = useSpacesFor({ permission: "agents:read" }, detail?.read_space_ids);
  const tabReads = {
    runs: overview ? runSpaces.length > 0 : canReadRuns(can),
    memory: memoryReach.offered,
    usedBy: overview ? agentSpaces.length > 0 : packageSightPermissions("agent").some(can),
  };
  // Only an agent has a narrower read: without `agents:read` a runner launches
  // it and follows its own runs, but does not see what it is made of.
  const fullRead = type !== "agent" || agentReach.offered;
  const { data: versionInfo } = useVersionInfo(type, type === "agent" ? packageId : undefined);
  // The model verdict alone: it holds whatever else blocks the run first. Read
  // here, beside the detail, so the alert does not wait for the loading gate.
  // In « Tous les espaces » the run's space is chosen at launch: no one space's pin is read.
  const modelBlocker = useAgentModelBlocker(type === "agent" ? packageId : undefined, {
    spanning: overview,
  });

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

  // The agents « Utilisé par » lists, which the overview counts.
  const usedByIds = pkgDetail?.agents.map((agent) => agent.id);
  const usedBy = useAgentsAmong(usedByIds, overview);
  const downloadPackage = usePackageDownload(scope, name);
  const downloadBundle = useAgentBundleExport(scope, name);
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
  if (error || !detail || (overview && isVersionView && !can(packagePermission(type, "read"))))
    return (
      <UnreadableDetail
        kind={type}
        version={isVersionView}
        id={packageId}
        error={error}
        pending={<PackageDetailSkeleton type={type} />}
      />
    );

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
    homeSpaceId: homeSpaceId ?? null,
    spaceIds: (agentDetail ?? pkgDetail)?.space_ids ?? [],
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

  // The catalogue sheet opens on the version the reader chose, and follows the current one otherwise.
  const catalogueVersion = catalogueVersionFor({
    isHistoricalVersion,
    source,
    version: versionDetail?.version,
  });

  // The working space's: in « Tous les espaces » the spaces it is active in say it. Absent from a
  // summary read (`agents:run` without `agents:read`), which the library does not answer.
  const availability = base?.availability;
  const availabilityBadge = !overview && availability && (
    <AvailabilityBadge type={type} availability={availability} />
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
            status={availabilityBadge}
            tabs={tabDefs}
            actions={
              <>
                {runButton}
                <AgentActions
                  packageId={packageId}
                  isHistoricalVersion={isHistoricalVersion}
                  downloadVersion={downloadVersion}
                  downloadPackage={downloadPackage}
                  downloadBundle={downloadBundle}
                  onCreateVersion={() => setCreatingVersion(true)}
                  unsavedReason={unsavedReason}
                  catalogueVersion={catalogueVersion}
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
            status={availabilityBadge}
            tabs={tabDefs}
            actions={
              <>
                <PackageActionsDropdown
                  packageId={packageId}
                  type={type}
                  detail={pkgDetail}
                  isHistoricalVersion={isHistoricalVersion}
                  downloadVersion={downloadVersion}
                  onDownload={downloadPackage}
                  onCreateVersion={() => setCreatingVersion(true)}
                  createVersionBlockedReason={unsavedReason}
                  catalogueVersion={catalogueVersion}
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
            <DetailTabPanel value="settings" framed>
              <AgentSettingsView
                versions={versionsProps}
                packageId={packageId}
                detail={agentDetail}
                version={versionLabel}
                isHistorical={isHistoricalVersion}
                inputWrapperOverride={historicalInputWrapper}
              />
            </DetailTabPanel>
            <DetailTabPanel value="memory">
              {tabReads.memory ? (
                <AgentMemoryTab packageId={packageId} />
              ) : (
                <RoleLimitNotice>{t("detail.roleLimit.memory")}</RoleLimitNotice>
              )}
            </DetailTabPanel>
          </>
        )}

        {type !== "agent" && (
          <>
            {/* Skill tab content. Both follow the version being viewed: the explorer
          through `versionLabel`, the overview through the version's own `content`. */}
            <DetailTabPanel value="overview">
              {pkgDetail && (
                <PackageOverview
                  packageId={packageId}
                  type={type}
                  name={displayName}
                  availability={pkgDetail.availability}
                  content={isHistoricalVersion ? versionDetail?.content : pkgDetail.content}
                  historical={isHistoricalVersion}
                  agentCount={!tabReads.usedBy || usedBy.isError ? null : usedBy.data?.length}
                  onOpenFiles={() => setTab("settings")}
                  onOpenUsage={() => setTab("usedBy")}
                />
              )}
            </DetailTabPanel>

            <DetailTabPanel value="settings" framed>
              <PackageSettingsView
                versions={versionsProps}
                packageId={packageId}
                detail={pkgDetail}
                version={versionLabel}
              />
            </DetailTabPanel>

            <DetailTabPanel value="usedBy">
              {!tabReads.usedBy ? (
                <RoleLimitNotice>{t("detail.roleLimit.usedBy")}</RoleLimitNotice>
              ) : (
                usedByIds && <PackageUsage agentIds={usedByIds} />
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
