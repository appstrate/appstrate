// SPDX-License-Identifier: Apache-2.0

import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  MoreHorizontal,
  ChevronDown,
  Download,
  Package,
  GitBranchPlus,
  GitFork,
  Pencil,
  CalendarPlus,
  Trash2,
  PackagePlus,
  SlidersHorizontal,
  FolderInput,
  Share2,
} from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@appstrate/ui/components/dropdown-menu";
import type { PackageType } from "@appstrate/core/validation";
import { packageEditPath } from "../../lib/package-paths";
import { packagePermission } from "@appstrate/core/permissions";
import { maySetPackageActive } from "../../lib/package-permissions";
import { usePermissions, useCurrentSpaceGrant } from "../../hooks/use-permissions";
import { MoveHomeSpaceDialog, MOVE_HOME_PARAM } from "./move-home-space-dialog";
import { SharePackageDialog, SHARE_PARAM } from "./share-package-dialog";
import { useModalParam } from "../../hooks/use-modal-param";

interface PackageActionsDropdownProps {
  packageId: string;
  type: PackageType;
  isOwned: boolean;
  isBuiltIn: boolean;
  isHistoricalVersion: boolean;
  /**
   * The package's home space (`home_space_id`), for the move dialog's
   * "everything but the current home" list. `null` when the caller does not
   * reach that space — the server withholds the id (RBAC spec §6.9).
   */
  homeSpaceId?: string | null;
  /**
   * `home_writable` off the package's own read: whether this caller holds the
   * type's `write` in its home space. Editing, publishing, moving and deleting
   * are gated on it, because it IS the predicate the server enforces
   * (`assertPackageMutationAccess`) — the SPA derives no write authority of its
   * own. `undefined` while the detail is loading, which reads as "no".
   */
  homeWritable?: boolean;
  /**
   * `home_deletable` off the same read: whether this caller holds the type's
   * `delete` in the home space. Gates "Supprimer" on its own, because
   * `<type>:delete` is an independent permission string and `DELETE` enforces
   * it in its own right — a custom space role granting `write` without it made
   * the item appear and 403 on click. `undefined` while the detail is loading,
   * which reads as "no".
   */
  homeDeletable?: boolean;
  /**
   * `home_shareable` off the same read: whether this caller holds the type's
   * `share` in the home space. Gates "Share…" on its own — a custom role may
   * grant `write` without it, or it without `write` (RBAC spec §6.10).
   */
  homeShareable?: boolean;
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
   * Whether the package is ACTIVE in the current space. The bundle export route
   * runs the execution gate (`isPackageActiveHere`), not the read gate, so a
   * package merely placed here — or placed and switched off — answers 404 on
   * click.
   */
  isActiveHere?: boolean;
  onCreateVersion?: () => void;
  onFork?: () => void;
  /** Override route navigation when editing is hosted in the current surface. */
  onEdit?: () => void;
  /**
   * False where the definition is edited in the package's own settings (agents,
   * integrations): one door to it, not a second one in this menu.
   */
  showEdit?: boolean;
  editLabel?: string;
  // Agent-specific
  runningRuns?: number;
  hasRuns?: boolean;
  hasMemories?: boolean;
  hasFileInput?: boolean;
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
  // Skill/Tool-specific
  canDeletePackage?: boolean;
  onDeletePackage?: () => void;
  // Activate in / deactivate from the current space — ONE verb, one pair of
  // doors (`POST` / `DELETE /api/spaces/{spaceId}/packages…`), for all four
  // package families. Activating is offered because the index page lists what
  // the space READS: a package placed here and switched off is reachable, and
  // this is where its reader turns that into a run. Deactivating is not
  // destructive — the placement and its settings stay, and so do connections.
  canActivate?: boolean;
  onActivate?: () => void;
  canDeactivate?: boolean;
  onDeactivate?: () => void;
  /** One mutation drives both directions, so one pending flag covers both. */
  activationPending?: boolean;
  /** Integration-detail prototype: use the same labelled page-action trigger as collections. */
  labelledTrigger?: boolean;
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
  isOwned,
  isBuiltIn,
  isHistoricalVersion,
  homeSpaceId,
  homeWritable,
  homeDeletable,
  homeShareable,
  downloadVersion,
  onDownload,
  onDownloadBundle,
  hasPublishedVersion,
  isActiveHere,
  onCreateVersion,
  onFork,
  onEdit,
  showEdit = true,
  editLabel,
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
  canDeletePackage,
  onDeletePackage,
  canActivate,
  onActivate,
  canDeactivate,
  onDeactivate,
  activationPending,
  labelledTrigger = false,
}: PackageActionsDropdownProps) {
  const { t } = useTranslation(["agents", "common", "settings"]);
  const navigate = useNavigate();
  const { can } = usePermissions();
  const spaceGrant = useCurrentSpaceGrant();
  const moveHome = useModalParam(MOVE_HOME_PARAM);
  const share = useModalParam(SHARE_PARAM);

  const isAgent = type === "agent";
  // The server's own verdict, not a re-derivation of it.
  const canWrite = homeWritable === true;
  // The exports carry the manifest and every authored file, so the two download
  // routes ask for `<type>:read` — the permission a summary-only caller (an
  // `agents:run` runner) does not hold. Without this the items 403 on click.
  const canRead = can(packagePermission(type, "read"));
  const isMutable = canWrite && !isBuiltIn && !isHistoricalVersion && isOwned;
  // Its own verdict, not `canWrite`'s: `DELETE` enforces `<type>:delete`, an
  // INDEPENDENT permission string, and a custom space role is an arbitrary
  // bundle — one granting `write` without `delete` used to render a Supprimer
  // item that 403s on click. The two travel together in every preset, so this
  // narrows nothing for a preset-only organization.
  const canDelete = homeDeletable === true;
  // Its own verdict, not `canWrite`'s: sharing is a third verb on the home
  // space, and a system package answers `false` (it is already readable
  // everywhere, and the route refuses it).
  const canShare = homeShareable === true && !isBuiltIn && !isHistoricalVersion && isOwned;
  // The activation verdict is the target space's, not the org∪space union `can`
  // computes: owning a personal space authorizes activating there even though
  // the `operator` preset held in it carries no `agents:configure` (§3.6). The
  // props say whether the action EXISTS here; `maySetPackageActive` says
  // whether this caller may perform it.
  const showDeactivate =
    !!canDeactivate && !!onDeactivate && maySetPackageActive(spaceGrant, type, false);
  const showActivate =
    !!canActivate && !!onActivate && !showDeactivate && maySetPackageActive(spaceGrant, type, true);
  const showDelete = !isBuiltIn && isOwned && canDelete;
  // Forking writes a NEW package in the current space, so it asks the current
  // space's write, not the home's verdict on a package it never writes.
  const showFork = can(packagePermission(type, "write")) && !isOwned && Boolean(onFork);
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

  // The manifest is no longer reachable from here, and does not need to be:
  // every page that mounts this dropdown carries both tabs — À propos renders
  // the manifest, the Contenu tab serves its raw `manifest.json`. That holds for
  // integrations too, which route to `pages/integration-detail.tsx` and have
  // their own tab set: dropping the menu item without a file explorer there
  // left an integration's `manifest.json` and `INTEGRATION.md` reachable only
  // by downloading the `.afps`, so that page mounts the explorer as well.
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size={labelledTrigger ? "sm" : "icon"}
            className={labelledTrigger ? "h-8 gap-1.5 px-2.5" : undefined}
            aria-label={labelledTrigger ? undefined : t("package.actions")}
          >
            {labelledTrigger ? (
              <>
                {t("pageActions.label", { ns: "common" })}
                <ChevronDown size={16} />
              </>
            ) : (
              <MoreHorizontal size={16} />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={isAgent ? "min-w-64" : undefined}>
          {isAgent ? (
            <>
              {hasAgentBuildActions && (
                <>
                  <DropdownMenuLabel>{t("detail.actions.agent")}</DropdownMenuLabel>
                  {isMutable && showEdit && (
                    <DropdownMenuItem
                      onSelect={() =>
                        onEdit ? onEdit() : navigate(packageEditPath(type, packageId))
                      }
                    >
                      <Pencil size={14} />
                      {editLabel ?? t("btn.edit")}
                    </DropdownMenuItem>
                  )}
                  {isMutable && onCreateVersion && (
                    <DropdownMenuItem onSelect={onCreateVersion}>
                      <GitBranchPlus size={14} />
                      {t("version.createVersion")}
                    </DropdownMenuItem>
                  )}
                  {showFork && (
                    <DropdownMenuItem onSelect={onFork}>
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
                  {showActivate && onActivate && (
                    <DropdownMenuItem disabled={activationPending} onSelect={onActivate}>
                      <PackagePlus size={14} />
                      {t("packages.activate", { ns: "settings" })}
                    </DropdownMenuItem>
                  )}
                  {showDeactivate && onDeactivate && (
                    <DropdownMenuItem disabled={activationPending} onSelect={onDeactivate}>
                      <PackagePlus size={14} className="rotate-180" />
                      {t("packages.deactivate", { ns: "settings" })}
                    </DropdownMenuItem>
                  )}
                  {/* Moving the home is the same authority as editing, since it is
                    the home that grants that authority; sharing is a verb of
                    its own on that same space (RBAC spec §6.10). Both act on
                    WHERE the package lives, so both belong in this group. */}
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
              {isMutable && onCreateVersion && (
                <DropdownMenuItem onSelect={onCreateVersion}>
                  <GitBranchPlus size={14} />
                  {t("version.createVersion")}
                </DropdownMenuItem>
              )}
              {isMutable && showEdit && (
                <DropdownMenuItem
                  onSelect={() => (onEdit ? onEdit() : navigate(packageEditPath(type, packageId)))}
                >
                  <Pencil size={14} />
                  {editLabel ?? t("btn.edit")}
                </DropdownMenuItem>
              )}
              {showFork && (
                <DropdownMenuItem onSelect={onFork}>
                  <GitFork size={14} />
                  {t("fork.button")}
                </DropdownMenuItem>
              )}
              {(showActivate || showDeactivate || isMutable || canShare || showDelete) && (
                <>
                  <DropdownMenuSeparator />
                  {showActivate && onActivate && (
                    <DropdownMenuItem disabled={activationPending} onSelect={onActivate}>
                      <PackagePlus size={14} />
                      {t("packages.activate", { ns: "settings" })}
                    </DropdownMenuItem>
                  )}
                  {showDeactivate && onDeactivate && (
                    <DropdownMenuItem disabled={activationPending} onSelect={onDeactivate}>
                      <PackagePlus size={14} className="rotate-180" />
                      {t("packages.deactivate", { ns: "settings" })}
                    </DropdownMenuItem>
                  )}
                  {/* Moving the home is the same authority as editing, since it is
                    the home that grants that authority; sharing is a verb of
                    its own on that same space (RBAC spec §6.10). Both act on
                    WHERE the package lives, so both belong in this group. */}
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
                  {showDelete && canDeletePackage && onDeletePackage && (
                    <DropdownMenuItem
                      onSelect={onDeletePackage}
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
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Mounted only while open: any way of closing a form modal abandons its input. */}
      {moveHome.value === packageId && (
        <MoveHomeSpaceDialog
          open
          onClose={moveHome.close}
          packageId={packageId}
          type={type}
          homeSpaceId={homeSpaceId}
        />
      )}
      {share.value === packageId && (
        <SharePackageDialog
          open
          onClose={share.close}
          packageId={packageId}
          type={type}
          homeSpaceId={homeSpaceId}
          canPublish={homeWritable === true}
          onMoveHome={() => {
            moveHome.open(packageId, SHARE_PARAM);
          }}
        />
      )}
    </>
  );
}
