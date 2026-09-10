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
  PackageMinus,
  PowerOff,
  SlidersHorizontal,
  FolderInput,
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
import { PACKAGE_PERMISSIONS } from "../../lib/package-permissions";
import { usePermissions } from "../../hooks/use-permissions";
import { MoveHomeSpaceDialog } from "./move-home-space-dialog";

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
   * Whether the package is installed in the CURRENT space. The bundle export
   * route runs the execution gate (`hasPackageAccess`), not the read gate, so a
   * package merely homed here would answer 404 on click.
   */
  isInstalledHere?: boolean;
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
  // Skill/Tool-specific
  canDeletePackage?: boolean;
  onDeletePackage?: () => void;
  // Uninstall from current space
  canUninstall?: boolean;
  onUninstall?: () => void;
  // Integration-specific: deactivate in the current space (non-destructive —
  // removes the space_packages row, keeps connections).
  canDeactivate?: boolean;
  onDeactivate?: () => void;
  deactivatePending?: boolean;
}

export function PackageActionsDropdown({
  packageId,
  type,
  isOwned,
  isBuiltIn,
  isHistoricalVersion,
  homeSpaceId,
  homeWritable,
  downloadVersion,
  onDownload,
  onDownloadBundle,
  hasPublishedVersion,
  isInstalledHere,
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
  canDeletePackage,
  onDeletePackage,
  canUninstall,
  onUninstall,
  canDeactivate,
  onDeactivate,
  deactivatePending,
}: PackageActionsDropdownProps) {
  const { t } = useTranslation(["agents", "common", "settings"]);
  const navigate = useNavigate();
  const { can } = usePermissions();
  const [moveHomeOpen, setMoveHomeOpen] = useState(false);

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
  // Same verdict: `<type>:delete` and `<type>:write` travel together in every
  // preset, and the server checks delete in its own right anyway.
  const canDelete = canWrite;
  // Deactivating / uninstalling an integration is the same route pair as
  // `integrations:uninstall`; the props say whether the action EXISTS here.
  const showDeactivate = !!canDeactivate && can("integrations:uninstall") && !!onDeactivate;
  const showUninstall = !!canUninstall && can("integrations:uninstall") && !!onUninstall;
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon">
            <MoreHorizontal size={16} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* ── Run with options (advanced launcher — per-run overrides) ── */}
          {isAgent && can("agents:run") && onRunWithOptions && (
            <>
              <DropdownMenuItem onSelect={onRunWithOptions}>
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
              agent is not installed HERE: that route is install-gated
              (`hasPackageAccess`), so the home alone does not open it. */}
          {canRead && isAgent && isInstalledHere && onDownloadBundle && (
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
              {can("runs:delete") && hasRuns && onDeleteRuns && (
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

          {/* ── Deactivate / Uninstall / Delete ── */}
          {(showDeactivate || showUninstall || showDelete) && (
            <>
              <DropdownMenuSeparator />
              {showDeactivate && (
                <DropdownMenuItem onSelect={onDeactivate} disabled={deactivatePending}>
                  <PowerOff size={14} />
                  {t("integrations.btn.deactivate", { ns: "settings" })}
                </DropdownMenuItem>
              )}
              {showUninstall && (
                <DropdownMenuItem
                  onSelect={onUninstall}
                  className="text-destructive focus:text-destructive"
                >
                  <PackageMinus size={14} />
                  {t("packages.uninstall", { ns: "settings" })}
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
