// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  MoreHorizontal,
  Download,
  Package,
  GitBranchPlus,
  GitFork,
  Pencil,
  CalendarPlus,
  Trash2,
  PackagePlus,
  PowerOff,
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
  DropdownMenuSeparator,
} from "@appstrate/ui/components/dropdown-menu";
import type { PackageType } from "@appstrate/core/validation";
import { packageEditPath } from "../../lib/package-paths";
import { maySetPackageActive, PACKAGE_PERMISSIONS } from "../../lib/package-permissions";
import { usePermissions, useCurrentSpaceGrant } from "../../hooks/use-permissions";
import { MoveHomeSpaceDialog } from "./move-home-space-dialog";
import { SharePackageDialog } from "./share-package-dialog";

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
}: PackageActionsDropdownProps) {
  const { t } = useTranslation(["agents", "common", "settings"]);
  const navigate = useNavigate();
  const { can } = usePermissions();
  const spaceGrant = useCurrentSpaceGrant();
  const [moveHomeOpen, setMoveHomeOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const isAgent = type === "agent";
  // Each package family is its own permission resource, so every gate below
  // asks for the string the matching route checks.
  const resource = PACKAGE_PERMISSIONS[type].resource;
  // The server's own verdict, not a re-derivation of it.
  const canWrite = homeWritable === true;
  // The exports carry the manifest and every authored file, so the two download
  // routes ask for `<type>:read` — the permission a summary-only caller (an
  // `agents:run` runner) does not hold. Without this the items 403 on click.
  const canRead = can(`${resource}:read`);
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

  // The manifest is no longer reachable from here, and does not need to be:
  // every page that mounts this dropdown carries both tabs — À propos renders
  // the manifest, the Contenu tab serves its raw `manifest.json`. That holds for
  // integrations too, which route to `pages/integration-detail.tsx` and have
  // their own tab set: dropping the menu item without a file explorer there
  // left an integration's `manifest.json` and `INTEGRATION.md` reachable only
  // by downloading the `.afps`, so that page mounts the explorer as well.
  return (
    <>
      <MoveHomeSpaceDialog
        open={moveHomeOpen}
        onClose={() => setMoveHomeOpen(false)}
        packageId={packageId}
        type={type}
        homeSpaceId={homeSpaceId}
      />
      <SharePackageDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        packageId={packageId}
        type={type}
        homeSpaceId={homeSpaceId}
        canPublish={!!homeWritable}
        // Co-authoring a package homed in a personal space starts by moving it
        // out — the space itself is never converted. One dialog hands over to
        // the other rather than stacking on top of it.
        onMoveHome={() => {
          setShareOpen(false);
          setMoveHomeOpen(true);
        }}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            data-testid="package-actions-trigger"
            aria-label={t("package.actions")}
          >
            <MoreHorizontal size={16} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* ── Run with options (advanced launcher — per-run overrides) ── */}
          {isAgent && can("agents:run") && onRunWithOptions && (
            <>
              <DropdownMenuItem
                onSelect={() => !runBlockedReason && onRunWithOptions()}
                disabled={!!runBlockedReason}
                title={runBlockedReason}
              >
                <SlidersHorizontal size={14} />
                {t("run.options.menuItem")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}

          {/* ── Download ── */}
          {canRead && downloadVersion && onDownload && (
            <DropdownMenuItem onSelect={() => onDownload(downloadVersion)}>
              <Download size={14} />
              {t("btn.download", { ns: "common" })}
            </DropdownMenuItem>
          )}

          {/* ── Download bundle (agent only — multi-package, transitive).
              Disabled when no version has been published: the export
              endpoint resolves `(packageId, version)` from the registry,
              so a draft-only package would 404. Hidden entirely when the
              agent is not ACTIVE here: that route runs the execution gate
              (`isPackageActiveHere`), so the home alone does not open it. */}
          {canRead && isAgent && isActiveHere && onDownloadBundle && (
            <DropdownMenuItem
              onSelect={() => hasPublishedVersion && onDownloadBundle(downloadVersion)}
              disabled={!hasPublishedVersion}
              title={!hasPublishedVersion ? t("bundle.requiresVersion") : undefined}
            >
              <Package size={14} />
              {t("bundle.download")}
            </DropdownMenuItem>
          )}

          {/* ── Create version ── */}
          {isMutable && onCreateVersion && (
            <DropdownMenuItem onSelect={onCreateVersion}>
              <GitBranchPlus size={14} />
              {t("version.createVersion")}
            </DropdownMenuItem>
          )}

          {/* ── Edit ── */}
          {isMutable && (
            <DropdownMenuItem onSelect={() => navigate(packageEditPath(type, packageId))}>
              <Pencil size={14} />
              {t("btn.edit")}
            </DropdownMenuItem>
          )}

          {/* ── Move to another home space — same authority as editing, since it
              is the home that grants that authority. Also the only way to clear
              the 409 a space deletion answers while it homes packages. */}
          {isMutable && (
            <DropdownMenuItem onSelect={() => setMoveHomeOpen(true)}>
              <FolderInput size={14} />
              {t("packages.moveHome", { ns: "settings" })}
            </DropdownMenuItem>
          )}

          {/* ── Share — the package's audience (RBAC spec §6.10). Offering it to
              a space places it there and no more: the recipient switches it on,
              because it runs with THEIR credentials. */}
          {canShare && (
            <DropdownMenuItem onSelect={() => setShareOpen(true)}>
              <Share2 size={14} />
              {t("packages.share", { ns: "settings" })}
            </DropdownMenuItem>
          )}

          {/* ── Fork — only read-only system packages (org-owned ones are edited directly) ── */}
          {can(`${resource}:write`) && !isOwned && onFork && (
            <DropdownMenuItem onSelect={onFork}>
              <GitFork size={14} />
              {t("fork.button")}
            </DropdownMenuItem>
          )}

          {/* ── Agent secondary actions ── */}
          {isAgent && (
            <>
              <DropdownMenuSeparator />
              {can("schedules:write") && !hasFileInput && onAddSchedule && (
                <DropdownMenuItem onSelect={onAddSchedule}>
                  <CalendarPlus size={14} />
                  {t("schedule.titleNew")}
                </DropdownMenuItem>
              )}
              {can("runs:delete") && can("runs:read-all") && hasRuns && onDeleteRuns && (
                <DropdownMenuItem
                  onSelect={onDeleteRuns}
                  disabled={runningRuns > 0}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 size={14} />
                  {t("detail.clearRuns")}
                </DropdownMenuItem>
              )}
              {can("persistence:delete") && hasMemories && onDeleteMemories && (
                <DropdownMenuItem
                  onSelect={onDeleteMemories}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 size={14} />
                  {t("detail.clearMemories")}
                </DropdownMenuItem>
              )}
            </>
          )}

          {/* ── Activate / Deactivate / Delete ── */}
          {(showActivate || showDeactivate || showDelete) && (
            <>
              <DropdownMenuSeparator />
              {showActivate && (
                <DropdownMenuItem onSelect={onActivate} disabled={activationPending}>
                  <PackagePlus size={14} />
                  {t("packages.activate", { ns: "settings" })}
                </DropdownMenuItem>
              )}
              {showDeactivate && (
                <DropdownMenuItem onSelect={onDeactivate} disabled={activationPending}>
                  <PowerOff size={14} />
                  {t("packages.deactivate", { ns: "settings" })}
                </DropdownMenuItem>
              )}
              {showDelete && isAgent && onDeleteAgent && (
                <DropdownMenuItem
                  onSelect={onDeleteAgent}
                  disabled={runningRuns > 0}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 size={14} />
                  {t("btn.delete")}
                </DropdownMenuItem>
              )}
              {showDelete && !isAgent && canDeletePackage && onDeletePackage && (
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
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
