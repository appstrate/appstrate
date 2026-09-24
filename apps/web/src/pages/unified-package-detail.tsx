// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { useParams, Link, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
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
import type { SchemaWrapper } from "@appstrate/core/form";
import { usePermissions, useHomeSpaceName } from "../hooks/use-permissions";
import { usePackageActivationState, useSetPackageActive } from "../hooks/use-library";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { LoadingState, ErrorState } from "../components/page-states";
import { ApiError } from "../api/client";
import { getVersionRedirect, hasActualChanges } from "../lib/version-helpers";
import { packageDetailPath } from "../lib/package-paths";
import { isModelSelectable } from "../lib/model-selectability";
import { hasInputFields } from "../lib/agent-input";
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
import { AgentInactiveAlert } from "../components/package-detail/agent-inactive-alert";
import {
  AgentRunsTab,
  AgentSchedulesTab,
  AgentMemoryTab,
  AgentApiTab,
} from "../components/package-detail/agent-tabs";
import { AgentConnectionsSection } from "../components/package-detail/agent-connections-section";
import { AgentConfigurationTab } from "../components/package-detail/agent-configuration-tab";
import { RunAgentButton } from "../components/run-agent-button";
import { PackageCard } from "../components/package-card";
import { useAgentReadiness } from "../hooks/use-agent-readiness";
import { useAgentIntegrationsReadiness } from "../hooks/use-agent-integrations-readiness";
import { useModels, useAgentModel } from "../hooks/use-models";
import { useProxies } from "../hooks/use-proxies";

type DetailTab =
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

/** A version that declares no parameters — distinct from "use the draft". */
const EMPTY_INPUT_WRAPPER: SchemaWrapper = { schema: { type: "object", properties: {} } };

// ─── Agent Run Button (inline, no wrapper) ────────────────────────────

function AgentRunButtonInline({
  packageId,
  versionLabel,
}: {
  packageId: string;
  versionLabel: string | undefined;
}) {
  const { t } = useTranslation("agents");
  const { data: detail } = usePackageDetail("agent", packageId);
  const { data: models } = useModels();
  const { data: agentModel } = useAgentModel(packageId);
  const readiness = useAgentReadiness(detail, agentModel?.modelId, models);
  // Launch-time integration readiness — drives the non-blocking orange badge.
  // Same server resolver as the run-kickoff 412 (see useAgentIntegrationsReadiness).
  const integrationsReady = useAgentIntegrationsReadiness(packageId);

  if (!detail) return null;

  const { hasModel, hasPrompt, hasRequiredSkills } = readiness;
  // The run gate is `system ∨ (placed here ∧ switched on)`: an agent this space
  // merely READS answers 404 `agent_not_active_in_space` on launch. The detail
  // response this button already holds answers it for this very space, so the
  // control says it without a second source to fall out of step with — and
  // without a system carve-out: a system agent switched off here is not active
  // here, and the run gate refuses it like any other.
  const inactiveHere = !detail.active;
  // Integration connection gaps don't disable Run — they surface as a warning
  // badge here and the recovery modal at run-kickoff (412 → MissingConnectionsModal).
  const runDisabled = inactiveHere || !hasPrompt || !hasRequiredSkills || !hasModel;
  const runDisabledTitle = inactiveHere
    ? t("detail.titleNotActive")
    : !hasPrompt
      ? t("detail.titleEmptyPrompt")
      : !hasRequiredSkills
        ? t("detail.titleMissingSkill")
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
  const { can } = usePermissions();
  // Whether this page is looking at the whole resource. Only an agent has a
  // narrower read; every other type reaches this route on its own `<type>:read`.
  const fullRead = type !== "agent" || can("agents:read");
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
  // falls back to the default tab for a hash naming anything outside the list
  // and the panels below key on its answer. The tab bar renders a subset of it.
  // Withheld from an `agents:run` caller without `agents:read`: each of the
  // four is fed by a field the summary read omits (manifest, prompt, authoring
  // history) or by a route — versions, files — that answers them 403.
  const allValidTabs: DetailTab[] = [
    "connections",
    "runs",
    "configuration",
    "memory",
    "api",
    "usedBy",
    ...(can("schedules:read") ? (["schedules"] as const) : []),
    ...(fullRead ? (["overview", "content", "versions", "diff"] as const) : []),
  ];
  const hasModelsAvailable = !!orgModels && orgModels.length > 0;
  const hasProxiesAvailable = !!orgProxies && orgProxies.length > 0;
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

  // A published version whose stored archive is unreadable EXISTS — redirecting
  // to the live page (what any other version failure does) would hide that it
  // is broken. Say so instead.
  if (
    isVersionView &&
    versionError instanceof ApiError &&
    versionError.code === "version_artifact_unavailable"
  ) {
    return <ErrorState message={t("files.errorMissingArtifact")} />;
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

  // ── Version-aware input wrapper ──
  // A pinned version edits its OWN parameter schema; an absent one means that
  // version declared none — distinct from `undefined`, which means "use draft".
  const effectiveInputWrapper = isHistoricalVersion
    ? ((versionDetail?.manifest?.input as SchemaWrapper | undefined) ?? EMPTY_INPUT_WRAPPER)
    : agentDetail?.input;
  const hasEffectiveInputFields = hasInputFields(effectiveInputWrapper);
  const effectiveShowConfigTab =
    can("agents:configure") &&
    type === "agent" &&
    (hasEffectiveInputFields || hasModelsAvailable || hasProxiesAvailable);

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
    homeSpaceName,
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
    { id: "connections", label: t("detail.tabConnections") },
    ...(effectiveShowConfigTab
      ? [{ id: "configuration" as DetailTab, label: t("detail.tabConfiguration") }]
      : []),
    ...(can("schedules:read")
      ? [{ id: "schedules" as DetailTab, label: t("detail.tabSchedules") }]
      : []),
    { id: "memory", label: t("detail.tabMemory") },
    { id: "api", label: t("detail.tabApi") },
    ...(fullRead ? [overviewTab, filesTab] : []),
  ];

  const pkgTabs: Array<{ id: DetailTab; label: string }> = [
    overviewTab,
    filesTab,
    { id: "usedBy", label: t("packages.usedBy") },
  ];

  // Shared tabs appended to all package types
  const sharedTabs: Array<{ id: DetailTab; label: string }> = [
    ...(!isBuiltIn && fullRead
      ? [{ id: "versions" as DetailTab, label: t("version.archives") }]
      : []),
    ...(hasArchivableChanges && !isVersionView && fullRead
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
        hasUnarchivedChanges={hasTimestampChanges}
        actionsLeft={
          type === "agent" ? (
            <AgentRunButtonInline packageId={packageId} versionLabel={versionLabel} />
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
                homeSpaceId={homeSpaceId}
                homeWritable={homeWritable}
                homeDeletable={homeDeletable}
                homeShareable={homeShareable}
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

      {type === "agent" && <ModelRequiredAlert />}

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
          inputWrapperOverride={isHistoricalVersion ? effectiveInputWrapper : undefined}
          isHistorical={isHistoricalVersion}
        />
      )}
      {type === "agent" && tab === "connections" && agentDetail && (
        <AgentConnectionsSection packageId={packageId} detail={agentDetail} />
      )}
      {type === "agent" && tab === "runs" && (
        <AgentRunsTab packageId={packageId} versionLabel={versionLabel} />
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
        hasUnarchivedChanges={hasTimestampChanges}
        lockVersion={(agentDetail ?? pkgDetail)?.lock_version}
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
