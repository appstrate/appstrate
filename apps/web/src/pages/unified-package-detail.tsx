// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { useParams, Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Tabs, TabsContent } from "@appstrate/ui/components/tabs";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { TriangleAlert } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import {
  usePackageDetail,
  useVersionDetail,
  useAgentBundleExport,
  usePackageDownload,
  useDeletePackage,
  useVersionInfo,
  type Versioned,
} from "../hooks/use-packages";
import type { AgentDetail, OrgPackageItemDetail, PackageType } from "@appstrate/shared-types";
import { useHomeSpaceName } from "../hooks/use-permissions";
import { canReadRuns, packageSightPermissions } from "@appstrate/core/permissions";
import { usePackageActivationState, useSetPackageActive } from "../hooks/use-library";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { LoadingState, EmptyState } from "../components/page-states";
import { ApiError } from "../api/client";
import { getVersionRedirect, hasActualChanges } from "../lib/version-helpers";
import { packageDetailPath } from "../lib/package-paths";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";

// Shared components
import { ConfirmModal } from "../components/confirm-modal";
import { SharedHeader } from "../components/package-detail/shared-header";
import { PackageActionsDropdown } from "../components/package-detail/package-actions-dropdown";
import { VersionBanners } from "../components/version-banners";
import { PackageOverview } from "../components/package-detail/package-overview";
import { CreateVersionModal } from "../components/create-version-modal";
import { ForkPackageModal } from "../components/fork-package-modal";
// Agent-specific components
import { AgentActions } from "../components/package-detail/agent-actions";
import { AgentRunsTab, AgentMemoryTab } from "../components/package-detail/agent-tabs";
import { AgentInactiveAlert } from "../components/package-detail/agent-inactive-alert";
import { AgentOverviewTab } from "../components/agent-detail/agent-overview-tab";
import { AgentSettingsView } from "../components/agent-detail/agent-settings-view";
import { DetailTabsList, DetailTabsTrigger } from "../components/agent-detail/agent-local-tabs";
import { AGENT_DETAIL_TABS } from "../lib/agent-detail-tabs";
import { RunAgentButton } from "../components/run-agent-button";
import { PackageUsage } from "../components/package-detail/package-usage";
import { PackageSettingsView } from "../components/package-detail/package-settings-view";
import { RoleLimitNotice } from "../components/role-limit-notice";
import { diagnosticsAllowLaunch, useAgentDiagnostics } from "../hooks/use-agent-diagnostics";

type DetailTab =
  "overview" | "runs" | "settings" | "memory" | "versions" | "diff" | "content" | "usedBy";

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
  const canReadAgent = usePermissions().can("agents:read");
  const diagnostics = useAgentDiagnostics(packageId, versionLabel);
  const result = diagnostics.data;
  // Without `agents:read` there is no verdict to wait for: the launch itself
  // checks readiness and opens the recovery flow, as on every launch surface.
  const runDisabled = canReadAgent && (diagnostics.isLoading || !diagnosticsAllowLaunch(result));
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
  const { can } = usePermissions();
  // Only an agent has a narrower read: without `agents:read` a runner launches
  // it and follows its own runs, but does not see what it is made of.
  const fullRead = type !== "agent" || can("agents:read");
  const location = useLocation();
  const navigate = useNavigate();
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
  const { data: detail, isLoading, error } = usePackageDetail(type, packageId);
  const { data: versionInfo } = useVersionInfo(type, type === "agent" ? packageId : undefined);

  // Agents list for "Used by" tab enrichment

  // Type-narrowed aliases for type-specific branches
  const agentDetail = type === "agent" ? (detail as Versioned<AgentDetail> | undefined) : undefined;
  const pkgDetail =
    type !== "agent" ? (detail as Versioned<OrgPackageItemDetail> | undefined) : undefined;

  const displayName = agentDetail?.display_name ?? pkgDetail?.name ?? pkgDetail?.id ?? "";
  const source = agentDetail?.source ?? pkgDetail?.source;
  // WHICH definition the server projected. Every type answers it now, from the
  // one function that decides it, so the read-only banner below is a single
  // condition rather than one per type.
  const definition = (agentDetail ?? pkgDetail)?.definition;
  const version = agentDetail?.version ?? pkgDetail?.version;
  const hasUnarchivedChanges =
    agentDetail?.has_unarchived_changes ?? pkgDetail?.has_unarchived_changes;
  const forkedFrom = agentDetail?.forked_from ?? pkgDetail?.forked_from ?? null;
  // Mutability is gated on whether the org owns the package row, not on its scope name.
  // Every package returned here is already org-scoped server-side, so anything that is not a
  // read-only system package is freely editable/deletable (registry checks happen at publish).
  const isOwned = source !== "system";

  const {
    data: versionDetail,
    isLoading: versionLoading,
    error: versionError,
  } = useVersionDetail(type, packageId, versionParam);

  // The server's own flag gates publishing (the header badge and the publish
  // dialog), as it does for `appstrate packages publish`: the server judges the
  // content itself — annexes included, which the manifest/prompt comparison
  // below cannot see — and answers `409 no_changes` when nothing moved. The
  // comparison only decides whether a diff tab has anything to show.
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
  const setActive = useSetPackageActive();
  const currentSpaceId = useCurrentSpaceId();
  // Only a skill or an MCP server needs this: their detail response carries no
  // `active`, so the library's projection of the placement is the only answer
  // available. An agent's detail answers for itself (`AgentDetail.active`,
  // read by `AgentRunButtonInline`, `AgentActions` and the banner below), and
  // asking the library too would be one page reading one fact twice — so the
  // query is not even mounted there.
  const { isActiveInCurrentSpace } = usePackageActivationState(packageId, {
    enabled: type !== "agent",
  });
  // The package's own detail response is the authority on both halves of the
  // home contract: the id (only when this caller reaches that space) and the
  // write verdict. `undefined` means "not loaded yet", which every gate reads
  // as "no".
  const homeSpaceId = (agentDetail ?? pkgDetail)?.home_space_id;
  const homeWritable = (agentDetail ?? pkgDetail)?.home_writable;
  const homeDeletable = (agentDetail ?? pkgDetail)?.home_deletable;
  const homeShareable = (agentDetail ?? pkgDetail)?.home_shareable;
  const homeSpaceName = useHomeSpaceName(homeSpaceId);
  const [forkOpen, setForkOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    type: "deletePackage" | "deactivatePackage";
    description: string;
  } | null>(null);

  // ── State ──
  // The tabs this caller may MOUNT — the single gate, since `useTabWithHash`
  // falls back to the default tab for a hash naming anything outside the list.
  // An agent's tabs are the same for every role: a tab whose read the caller
  // lacks says so in its panel (`RoleLimitNotice`) instead of disappearing, so
  // the page reads the same whatever the role and only its content changes.
  const agentTabVisible = (_id: (typeof AGENT_DETAIL_TABS)[number]) => true;
  const allValidTabs: DetailTab[] =
    type === "agent"
      ? AGENT_DETAIL_TABS.filter(agentTabVisible)
      : // `content` stays valid only to redirect old links to Paramètres.
        [
          "overview",
          "versions",
          "diff",
          "settings",
          "content",
          ...(tabReads.usedBy ? (["usedBy"] as const) : []),
        ];
  // Every detail has a useful summary; explicit file/version deep links still win.
  const defaultTab: DetailTab = "overview";
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
    if (!["map", "files", "configuration", "versions", "diff"].includes(legacyTab)) return;
    const search = new URLSearchParams(location.search);
    const section =
      legacyTab === "configuration"
        ? search.get("agentConfig") || "model"
        : legacyTab === "diff"
          ? "versions"
          : legacyTab;
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
    // Versions and their diff moved into Paramètres › Explorer.
    if (type !== "agent" && (tab === "versions" || tab === "diff")) {
      const search = new URLSearchParams(location.search);
      search.set("packageSettings", "versions");
      navigate(
        { pathname: location.pathname, search: `?${search.toString()}`, hash: "settings" },
        { replace: true },
      );
      return;
    }
    // A package's files moved into Paramètres › Explorer.
    if (tab === "content") setTab("settings");
  }, [
    tab,
    hasArchivableChanges,
    isVersionView,
    source,
    defaultTab,
    setTab,
    type,
    location,
    navigate,
  ]);
  const [createVersionOpen, setCreateVersionOpen] = useState(false);
  // ── Loading / Error ──
  if (isLoading || (isVersionView && versionLoading)) return <LoadingState />;
  if (error || !detail) {
    return <Navigate to="/" replace />;
  }

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

  // ── Version-aware input schema ──
  // A version snapshot does not carry the workspace's model, proxy or saved
  // values. The only honest form shape available here is the archived AFPS
  // input schema. An empty schema is distinct from undefined, which means
  // "fall back to the current draft" in the form components.
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

  // The artifact file explorer — one generic tab for every package type. Keeps
  // the historical `"content"` id so existing deep links (#content) still land.
  // The rendered manifest, next to the raw artifact it comes from.
  const overviewTab: { id: DetailTab; label: string } = {
    id: "overview",
    label: t("detail.overview.summary"),
  };

  const agentTabLabels: Record<(typeof AGENT_DETAIL_TABS)[number], string> = {
    overview: t("detail.overview.summary"),
    runs: t("detail.tabRuns"),
    memory: t("detail.tabMemory"),
    settings: t("detail.tabSettings"),
  };
  const agentTabs: Array<{ id: DetailTab; label: string }> = AGENT_DETAIL_TABS.filter(
    agentTabVisible,
  ).map((id) => ({
    id,
    label: agentTabLabels[id],
  }));

  const pkgTabs: Array<{ id: DetailTab; label: string }> = [
    overviewTab,
    { id: "settings", label: t("detail.tabSettings") },
    ...(tabReads.usedBy ? [{ id: "usedBy" as DetailTab, label: t("packages.usedBy") }] : []),
  ];

  const tabDefs = type === "agent" ? agentTabs : pkgTabs;

  // Versions live in Paramètres › Explorer for every type.
  const versionsProps = {
    // Restoring writes the draft, deleting removes a version: both are judged
    // in the package's HOME space, never in the space being browsed.
    canRestore: !isBuiltIn && !!homeWritable,
    canDelete: !isBuiltIn && !!homeDeletable,
    latestVersion: latestVersionForDiff,
    currentManifest,
    currentContent,
    hasUnarchivedChanges: hasArchivableChanges && !isVersionView,
  };

  const versionLabel = isHistoricalVersion ? versionDetail?.version : undefined;

  return (
    <div>
      <SharedHeader
        detail={unifiedForHeader}
        isHistoricalVersion={isHistoricalVersion}
        // The server's own flag, as for the publish dialog below.
        hasUnarchivedChanges={hasTimestampChanges}
        latestPublishedVersion={versionInfo?.latest_published_version}
        activeSubpage={{
          label: tabDefs.find((item) => item.id === tab)?.label ?? overviewTab.label,
        }}
        statusBadges={
          // The readiness verdict reads the agent's content: shown to whoever may read it.
          type === "agent" && fullRead ? (
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
            />
          ) : (
            <div className="flex items-center gap-2">
              <PackageActionsDropdown
                labelledTrigger
                packageId={packageId}
                type={type}
                isOwned={isOwned}
                isBuiltIn={isBuiltIn}
                isHistoricalVersion={isHistoricalVersion}
                homeSpaceId={homeSpaceId}
                homeWritable={homeWritable}
                homeDeletable={homeDeletable}
                homeShareable={homeShareable}
                downloadVersion={downloadVersion}
                onDownload={downloadPackage}
                onCreateVersion={() => setCreateVersionOpen(true)}
                onFork={() => setForkOpen(true)}
                // The definition is edited in Paramètres › Définition.
                showEdit={false}
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
                // ONE pair of doors, for every family: a skill or an MCP
                // server is switched on and off in a space exactly like an
                // agent, through `POST` / `DELETE /api/spaces/{id}/packages`.
                // Switching off keeps the placement and its settings.
                canActivate={isActiveInCurrentSpace === false}
                onActivate={() => {
                  if (!currentSpaceId) return;
                  setActive.mutate(
                    { spaceId: currentSpaceId, packageId, active: true },
                    // Same as the DEACTIVATE path below: the optimistic write
                    // shows the switch taken and its rollback says nothing, so
                    // the server's refusal is reported here or nowhere.
                    {
                      onError: (err) =>
                        toast.error(err instanceof Error ? err.message : t("error.generic")),
                    },
                  );
                }}
                canDeactivate={isActiveInCurrentSpace === true}
                onDeactivate={() => {
                  setConfirmAction({
                    type: "deactivatePackage",
                    description: t("packages.deactivateConfirm", {
                      name: displayName,
                      ns: "settings",
                    }),
                  });
                }}
                activationPending={setActive.isPending}
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

      {/* Placed here, switched off. The page renders in full — reading and
          configuring an agent is not running it — and says the one thing that
          would otherwise turn a click into a 404. */}
      {agentDetail && !agentDetail.active && <AgentInactiveAlert packageId={packageId} />}

      {/* Nothing has ever been published and the working copy is not this
          reader's: what the page renders below is the author's work in
          progress. Saying it is what makes the greyed-out Run button legible
          — and the page renders at all precisely because reading a definition
          is not running it. True of every package type: the server answers
          `definition` for all four from one function. */}
      {definition === "draft" && !homeWritable && (
        <Alert className="mb-4">
          <AlertDescription>{t("detail.draftReadOnly")}</AlertDescription>
        </Alert>
      )}

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
              {fullRead ? (
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
            </TabsContent>
            <TabsContent
              value="runs"
              className="bg-card mt-0 overflow-hidden rounded-lg border p-6 shadow-sm"
            >
              {tabReads.runs ? (
                <AgentRunsTab packageId={packageId} versionLabel={versionLabel} />
              ) : (
                <RoleLimitNotice>{t("detail.roleLimit.runs")}</RoleLimitNotice>
              )}
            </TabsContent>
            <TabsContent
              value="settings"
              className="bg-card mt-0 overflow-clip rounded-lg border shadow-sm"
            >
              <AgentSettingsView
                versions={versionsProps}
                packageId={packageId}
                detail={agentDetail}
                version={versionLabel}
                isHistorical={isHistoricalVersion}
                currentManifest={currentManifest}
                currentContent={currentContent}
              />
            </TabsContent>
            <TabsContent
              value="memory"
              className="bg-card mt-0 overflow-hidden rounded-lg border shadow-sm"
            >
              {tabReads.memory ? (
                <AgentMemoryTab packageId={packageId} />
              ) : (
                <RoleLimitNotice className="m-6">{t("detail.roleLimit.memory")}</RoleLimitNotice>
              )}
            </TabsContent>
          </Tabs>
        </div>
      )}

      {type !== "agent" && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as DetailTab)}>
          <DetailTabsList className="mt-6 mb-3">
            {tabDefs.map((td) => (
              <DetailTabsTrigger key={td.id} value={td.id}>
                {td.label}
              </DetailTabsTrigger>
            ))}
          </DetailTabsList>
          {/* Non-Agent tab content */}
          {/* Both follow the version being viewed: the explorer through
          `versionLabel`, the overview through the manifest picked above. */}
          <TabsContent value="overview" className="bg-card mt-0 rounded-lg border p-6 shadow-sm">
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
          </TabsContent>

          {(type === "skill" || type === "mcp-server") && (
            <TabsContent
              value="settings"
              className="bg-card mt-0 overflow-clip rounded-lg border shadow-sm"
            >
              <PackageSettingsView
                versions={versionsProps}
                type={type}
                packageId={packageId}
                detail={pkgDetail}
                version={versionLabel}
                canEditDefinition={
                  isOwned &&
                  can(type === "skill" ? "skills:write" : "mcp-servers:write") &&
                  !isHistoricalVersion
                }
              />
            </TabsContent>
          )}

          <TabsContent value="usedBy" className="bg-card mt-0 rounded-lg border p-6 shadow-sm">
            {pkgDetail && <PackageUsage agentIds={pkgDetail.agents.map((agent) => agent.id)} />}
          </TabsContent>
        </Tabs>
      )}

      <CreateVersionModal
        open={createVersionOpen}
        onClose={() => setCreateVersionOpen(false)}
        type={type}
        packageId={packageId}
        hasUnarchivedChanges={hasTimestampChanges}
        etag={(agentDetail ?? pkgDetail)?.etag}
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
        isPending={deletePkgMutation.isPending || setActive.isPending}
        confirmLabel={
          confirmAction?.type === "deactivatePackage"
            ? t("packages.deactivate", { ns: "settings" })
            : undefined
        }
        onConfirm={() => {
          if (!confirmAction) return;
          const close = () => setConfirmAction(null);
          if (confirmAction.type === "deactivatePackage") {
            if (!currentSpaceId) return;
            setActive.mutate(
              { spaceId: currentSpaceId, packageId, active: false },
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
