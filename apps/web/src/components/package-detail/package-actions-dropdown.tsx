// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Download,
  Package,
  GitBranchPlus,
  GitFork,
  CalendarPlus,
  Trash2,
  PackagePlus,
  SlidersHorizontal,
  FolderInput,
  Share2,
} from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@appstrate/ui/components/dropdown-menu";
import { PageActionsMenu } from "../page-actions-menu";
import type { PackageType } from "@appstrate/core/validation";
import type { AgentDetail, OrgPackageItemDetail } from "@appstrate/shared-types";
import { packagePermission } from "@appstrate/core/permissions";
import { usePermissions } from "../../hooks/use-permissions";
import { useDeletePackage } from "../../hooks/use-packages";
import { usePackageActivation } from "../../hooks/use-library";
import { splitPackageRef } from "../../lib/package-paths";
import { ConfirmModal } from "../confirm-modal";
import { ForkPackageModal } from "../fork-package-modal";
import { isOwnedSource } from "./owned-source";
import { MoveHomeSpaceDialog, MOVE_HOME_PARAM } from "./move-home-space-dialog";
import { SharePackageDialog, SHARE_PARAM } from "./share-package-dialog";
import { useModalParam } from "../../hooks/use-modal-param";

/**
 * What the menu reads off the package's own detail response (`AgentDetail` or
 * `OrgPackageItemDetail`): the home contract, whose verdicts gate every act on
 * the live object, and the facts the confirmations name. `agents` (the agents
 * using it) is on the non-agent shape only; deleting a package that is used is
 * refused.
 */
type PackageActionsDetail = Pick<
  AgentDetail,
  | "source"
  | "display_name"
  | "home_space_id"
  | "home_writable"
  | "home_deletable"
  | "home_shareable"
> &
  Partial<Pick<OrgPackageItemDetail, "name" | "agents">>;

interface PackageActionsDropdownProps {
  packageId: string;
  type: PackageType;
  /** `undefined` while the detail is loading, which every gate reads as "no". */
  detail: PackageActionsDetail | undefined;
  isHistoricalVersion: boolean;
  downloadVersion?: string;
  onDownload?: (version: string) => void;
  /** Agent-only: export the full transitive bundle (.afps-bundle). */
  onDownloadBundle?: (version?: string) => void;
  /** Agent-only: true when the package has at least one published version.
   *  The bundle export endpoint resolves versions from the registry; a
   *  draft-only agent (versionCount === 0) would 404, so we disable the
   *  menu item and surface a tooltip pointing to "Créer une version". */
  hasPublishedVersion?: boolean;
  /**
   * Whether the package is ACTIVE in the current space; `undefined` when not
   * known yet, which offers neither switch. The bundle export route runs the
   * execution gate (`isPackageActiveHere`), not the read gate, so a package
   * merely placed here — or placed and switched off — answers 404 on click.
   */
  isActiveHere?: boolean;
  onCreateVersion?: () => void;
  /** Why « Créer une version » is held back, already translated; `undefined` when it is not. */
  createVersionBlockedReason?: string;
  // Agent-specific
  runningRuns?: number;
  hasRuns?: boolean;
  hasMemories?: boolean;
  hasFileInput?: boolean;
  /** Agent-only: deleting an agent is the agent page's own confirmation. */
  onDeleteAgent?: () => void;
  onDeleteRuns?: () => void;
  onAddSchedule?: () => void;
  onDeleteMemories?: () => void;
  /** Agent-only: open the advanced run launcher (per-run overrides). */
  onRunWithOptions?: () => void;
  /**
   * Agent-only: why this caller cannot launch at all, already translated.
   * Set when the package has never been published and its working copy is not
   * theirs to run — the launcher would open on a version that does not exist.
   * `undefined` means launchable.
   */
  runBlockedReason?: string;
}

/** A disabled menu item takes no focus or pointer event: its reason is shown, not titled. */
function DisabledItemLabel({ label, reason }: { label: string; reason?: string }) {
  if (!reason) return label;
  return (
    <span className="flex max-w-56 flex-col">
      {label}
      <span className="text-xs">{reason}</span>
    </span>
  );
}

export function PackageActionsDropdown({
  packageId,
  type,
  detail,
  isHistoricalVersion,
  downloadVersion,
  onDownload,
  onDownloadBundle,
  hasPublishedVersion,
  isActiveHere,
  onCreateVersion,
  createVersionBlockedReason,
  runningRuns = 0,
  hasRuns,
  hasMemories,
  hasFileInput,
  onDeleteAgent,
  onDeleteRuns,
  onAddSchedule,
  onDeleteMemories,
  onRunWithOptions,
  runBlockedReason,
}: PackageActionsDropdownProps) {
  const { t } = useTranslation(["agents", "common", "settings"]);
  const { can } = usePermissions();
  const activation = usePackageActivation(packageId);
  const deletePkg = useDeletePackage(type);
  const moveHome = useModalParam(MOVE_HOME_PARAM);
  const share = useModalParam(SHARE_PARAM);
  const fork = useModalParam("fork");
  // `confirm` keeps its value while the dialog fades out, so the wording does not change under it.
  const [confirm, setConfirm] = useState<"delete" | "deactivate">("delete");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const askConfirm = (kind: "delete" | "deactivate") => {
    setConfirm(kind);
    setConfirmOpen(true);
  };

  const isOwned = isOwnedSource(detail?.source);
  const displayName = detail?.display_name || detail?.name || packageId;

  const isAgent = type === "agent";
  // The server's own verdict, not a re-derivation of it.
  const canWrite = detail?.home_writable === true;
  // The exports carry the manifest and every authored file, so the two download
  // routes ask for `<type>:read` — the permission a summary-only caller (an
  // `agents:run` runner) does not hold. Without this the items 403 on click.
  const canRead = can(packagePermission(type, "read"));
  const isMutable = canWrite && !isHistoricalVersion && isOwned;
  // Its own verdict, not `canWrite`'s: `DELETE` enforces `<type>:delete`, an
  // INDEPENDENT permission string, and a custom space role is an arbitrary
  // bundle — one granting `write` without `delete` must not render a Supprimer
  // item that 403s on click. The two travel together in every preset, so this
  // narrows nothing for a preset-only organization.
  const canDelete = detail?.home_deletable === true;
  // Its own verdict, not `canWrite`'s: sharing is a third verb on the home
  // space, and a system package answers `false` (it is already readable
  // everywhere, and the route refuses it).
  const canShare = detail?.home_shareable === true && !isHistoricalVersion && isOwned;
  // Activating is a space placement switch, one pair of doors for every family;
  // deactivating keeps the placement and its settings. Whether the act EXISTS
  // follows the package's state here; `usePackageActivation` says whether this
  // caller may perform it — the target space's verdict, not the org∪space union
  // `can` computes (owning a personal space authorizes it, §3.6).
  const showDeactivate = isActiveHere === true && activation.mayDeactivate;
  const showActivate = isActiveHere === false && activation.mayActivate;
  const showDelete = isOwned && canDelete;
  // Deleting a skill, MCP server or integration an agent still uses is refused.
  const canDeletePackage = !!detail?.agents && detail.agents.length === 0;
  // Forking writes a NEW package in the current space, so it asks the current
  // space's write, not the home's verdict on a package it never writes.
  const showFork = can(packagePermission(type, "write")) && !isOwned;
  // Clearing runs deletes every member's runs of this agent, so the route asks
  // `runs:read-all` on top of `runs:delete`; clearing memories is its own verb.
  const showDeleteRuns =
    can("runs:delete") && can("runs:read-all") && !!hasRuns && Boolean(onDeleteRuns);
  const showDeleteMemories =
    can("persistence:delete") && !!hasMemories && Boolean(onDeleteMemories);
  const hasAgentBuildActions = isAgent && (isMutable || showFork);
  const hasAgentExecutionActions =
    isAgent &&
    ((can("agents:run") && Boolean(onRunWithOptions)) ||
      (can("schedules:write") && !hasFileInput && Boolean(onAddSchedule)));
  const hasAgentExportActions =
    isAgent && canRead && Boolean((downloadVersion && onDownload) || onDownloadBundle);
  // Every item below carries its own verdict; the group exists when one does.
  const hasAgentAdministrationActions =
    isAgent &&
    (showDeleteRuns ||
      showDeleteMemories ||
      showActivate ||
      showDeactivate ||
      isMutable ||
      canShare ||
      (showDelete && Boolean(onDeleteAgent)));

  const createVersionItem = isMutable && onCreateVersion && (
    <DropdownMenuItem
      onSelect={() => !createVersionBlockedReason && onCreateVersion()}
      disabled={!!createVersionBlockedReason}
    >
      <GitBranchPlus size={14} />
      <DisabledItemLabel label={t("version.createVersion")} reason={createVersionBlockedReason} />
    </DropdownMenuItem>
  );

  // Where the package runs and where it lives, the same group in both menus:
  // moving the home is the same authority as editing, since it is the home
  // that grants that authority; sharing is a verb of its own on that same space
  // (RBAC spec §6.10).
  const placementItems = (
    <>
      {showActivate && (
        <DropdownMenuItem disabled={activation.pending} onSelect={() => activation.activate()}>
          <PackagePlus size={14} />
          {t("packages.activate", { ns: "settings" })}
        </DropdownMenuItem>
      )}
      {showDeactivate && (
        <DropdownMenuItem disabled={activation.pending} onSelect={() => askConfirm("deactivate")}>
          <PackagePlus size={14} className="rotate-180" />
          {t("packages.deactivate", { ns: "settings" })}
        </DropdownMenuItem>
      )}
      {isMutable && (
        <DropdownMenuItem onSelect={() => moveHome.open(packageId)}>
          <FolderInput size={14} />
          {t("packages.moveHome", { ns: "settings" })}
        </DropdownMenuItem>
      )}
      {canShare && (
        <DropdownMenuItem onSelect={() => share.open(packageId)}>
          <Share2 size={14} />
          {t("packages.share", { ns: "settings" })}
        </DropdownMenuItem>
      )}
    </>
  );

  // The manifest is not reachable from here, and does not need to be:
  // every page that mounts this dropdown carries both tabs — À propos renders
  // the manifest, the Contenu tab serves its raw `manifest.json`. That holds for
  // integrations too, which route to `pages/integration-detail.tsx` and have
  // their own tab set, and that page mounts the file explorer as well, so an
  // integration's `manifest.json` and `INTEGRATION.md` are reachable without
  // downloading the `.afps`.
  return (
    <>
      <PageActionsMenu contentClassName={isAgent ? "min-w-64" : undefined}>
        {isAgent ? (
          <>
            {hasAgentBuildActions && (
              <>
                <DropdownMenuLabel>{t("detail.actions.agent")}</DropdownMenuLabel>
                {createVersionItem}
                {showFork && (
                  <DropdownMenuItem onSelect={() => fork.open()}>
                    <GitFork size={14} />
                    {t("fork.button")}
                  </DropdownMenuItem>
                )}
              </>
            )}

            {hasAgentExecutionActions && (
              <>
                {hasAgentBuildActions && <DropdownMenuSeparator />}
                <DropdownMenuLabel>{t("detail.actions.execution")}</DropdownMenuLabel>
                {can("agents:run") && onRunWithOptions && (
                  <DropdownMenuItem
                    onSelect={() => !runBlockedReason && onRunWithOptions()}
                    disabled={!!runBlockedReason}
                  >
                    <SlidersHorizontal size={14} />
                    <DisabledItemLabel
                      label={t("run.options.menuItem")}
                      reason={runBlockedReason}
                    />
                  </DropdownMenuItem>
                )}
                {can("schedules:write") && !hasFileInput && onAddSchedule && (
                  <DropdownMenuItem onSelect={onAddSchedule}>
                    <CalendarPlus size={14} />
                    {t("schedule.titleNew")}
                  </DropdownMenuItem>
                )}
              </>
            )}

            {hasAgentExportActions && (
              <>
                {(hasAgentBuildActions || hasAgentExecutionActions) && <DropdownMenuSeparator />}
                <DropdownMenuLabel>{t("detail.actions.export")}</DropdownMenuLabel>
                {downloadVersion && onDownload && (
                  <DropdownMenuItem onSelect={() => onDownload(downloadVersion)}>
                    <Download size={14} />
                    {t("btn.download", { ns: "common" })}
                  </DropdownMenuItem>
                )}
                {isActiveHere && onDownloadBundle && (
                  <DropdownMenuItem
                    onSelect={() => hasPublishedVersion && onDownloadBundle(downloadVersion)}
                    disabled={!hasPublishedVersion}
                  >
                    <Package size={14} />
                    <DisabledItemLabel
                      label={t("bundle.download")}
                      reason={hasPublishedVersion ? undefined : t("bundle.requiresVersion")}
                    />
                  </DropdownMenuItem>
                )}
              </>
            )}

            {hasAgentAdministrationActions && (
              <>
                {(hasAgentBuildActions || hasAgentExecutionActions || hasAgentExportActions) && (
                  <DropdownMenuSeparator />
                )}
                <DropdownMenuLabel>{t("detail.actions.administration")}</DropdownMenuLabel>
                {showDeleteRuns && (
                  <DropdownMenuItem
                    onSelect={onDeleteRuns}
                    disabled={runningRuns > 0}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 size={14} />
                    {t("detail.clearRuns")}
                  </DropdownMenuItem>
                )}
                {showDeleteMemories && (
                  <DropdownMenuItem
                    onSelect={onDeleteMemories}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 size={14} />
                    {t("detail.clearMemories")}
                  </DropdownMenuItem>
                )}
                {placementItems}
                {showDelete && onDeleteAgent && (
                  <DropdownMenuItem
                    onSelect={onDeleteAgent}
                    disabled={runningRuns > 0}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 size={14} />
                    {t("btn.delete")}
                  </DropdownMenuItem>
                )}
              </>
            )}
          </>
        ) : (
          <>
            {canRead && downloadVersion && onDownload && (
              <DropdownMenuItem onSelect={() => onDownload(downloadVersion)}>
                <Download size={14} />
                {t("btn.download", { ns: "common" })}
              </DropdownMenuItem>
            )}
            {createVersionItem}
            {showFork && (
              <DropdownMenuItem onSelect={() => fork.open()}>
                <GitFork size={14} />
                {t("fork.button")}
              </DropdownMenuItem>
            )}
            {(showActivate || showDeactivate || isMutable || canShare || showDelete) && (
              <>
                <DropdownMenuSeparator />
                {placementItems}
                {showDelete && canDeletePackage && (
                  <DropdownMenuItem
                    onSelect={() => askConfirm("delete")}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 size={14} />
                    {t("btn.delete")}
                  </DropdownMenuItem>
                )}
              </>
            )}
          </>
        )}
      </PageActionsMenu>

      {/* Mounted only while open: any way of closing a form modal abandons its input. */}
      {moveHome.value === packageId && isMutable && (
        <MoveHomeSpaceDialog
          onClose={moveHome.close}
          packageId={packageId}
          type={type}
          homeSpaceId={detail?.home_space_id}
        />
      )}
      {share.value === packageId && canShare && (
        <SharePackageDialog
          onClose={share.close}
          packageId={packageId}
          type={type}
          homeSpaceId={detail?.home_space_id}
          canPublish={canWrite}
          onMoveHome={() => {
            moveHome.open(packageId, SHARE_PARAM);
          }}
        />
      )}
      {fork.value !== null && showFork && (
        <ForkPackageModal
          onClose={fork.close}
          onLeave={fork.leave}
          packageId={packageId}
          defaultName={splitPackageRef(packageId).name}
          type={type}
        />
      )}

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t(confirm === "deactivate" ? "detail.deactivateTitle" : "detail.deletePackageTitle")}
        description={
          confirm === "deactivate"
            ? t("packages.deactivateConfirm", { name: displayName, ns: "settings" })
            : t("packages.deleteConfirm", {
                type: t(`packages.type.${type}`, { ns: "settings" }),
                name: displayName,
                ns: "settings",
              })
        }
        confirmLabel={
          confirm === "deactivate"
            ? t("packages.deactivate", { ns: "settings" })
            : t("btn.delete", { ns: "common" })
        }
        isPending={activation.pending || deletePkg.isPending}
        onConfirm={() => {
          const onSuccess = () => setConfirmOpen(false);
          if (confirm === "deactivate") activation.deactivate({ onSuccess });
          else deletePkg.mutate(packageId, { onSuccess });
        }}
      />
    </>
  );
}
