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
  PackageMinus,
  PowerOff,
  SlidersHorizontal,
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
import { PACKAGE_PERMISSIONS } from "../../lib/package-permissions";
import { usePermissions } from "../../hooks/use-permissions";

interface PackageActionsDropdownProps {
  packageId: string;
  type: PackageType;
  isOwned: boolean;
  isBuiltIn: boolean;
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
  onCreateVersion?: () => void;
  onFork?: () => void;
  /** Override route navigation when editing is hosted in the current surface. */
  onEdit?: () => void;
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
  /** Integration-detail prototype: use the same labelled page-action trigger as collections. */
  labelledTrigger?: boolean;
}

export function PackageActionsDropdown({
  packageId,
  type,
  isOwned,
  isBuiltIn,
  isHistoricalVersion,
  downloadVersion,
  onDownload,
  onDownloadBundle,
  hasPublishedVersion,
  onCreateVersion,
  onFork,
  onEdit,
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
  canDeletePackage,
  onDeletePackage,
  canUninstall,
  onUninstall,
  canDeactivate,
  onDeactivate,
  deactivatePending,
  labelledTrigger = false,
}: PackageActionsDropdownProps) {
  const { t } = useTranslation(["agents", "common", "settings"]);
  const navigate = useNavigate();
  const { can } = usePermissions();

  const isAgent = type === "agent";
  // Each package family is its own permission resource, so every gate below
  // asks for the string the matching route checks.
  const resource = PACKAGE_PERMISSIONS[type].resource;
  const canWrite = can(`${resource}:write`);
  // The exports carry the manifest and every authored file, so the two download
  // routes ask for `<type>:read` — the permission a summary-only caller (an
  // `agents:run` runner) does not hold. Without this the items 403 on click.
  const canRead = can(`${resource}:read`);
  const isMutable = canWrite && !isBuiltIn && !isHistoricalVersion && isOwned;
  const canDelete = can(`${resource}:delete`);
  // Deactivating / uninstalling an integration is the same route pair as
  // `integrations:uninstall`; the props say whether the action EXISTS here.
  const showDeactivate = !!canDeactivate && can("integrations:uninstall") && !!onDeactivate;
  const showUninstall = !!canUninstall && can("integrations:uninstall") && !!onUninstall;
  const showDelete = !isBuiltIn && isOwned && canDelete;
  const hasAgentBuildActions = isAgent && (isMutable || (canWrite && !isOwned && Boolean(onFork)));
  const hasAgentExecutionActions =
    isAgent &&
    ((can("agents:run") && Boolean(onRunWithOptions)) ||
      (can("schedules:write") && !hasFileInput && Boolean(onAddSchedule)));
  const hasAgentExportActions =
    isAgent && canRead && Boolean((downloadVersion && onDownload) || onDownloadBundle);
  const hasAgentAdministrationActions =
    isAgent &&
    canDelete &&
    Boolean(
      (hasRuns && onDeleteRuns) ||
      (hasMemories && onDeleteMemories) ||
      (showUninstall && onUninstall) ||
      (showDelete && onDeleteAgent),
    );

  // The manifest is no longer reachable from here, and does not need to be:
  // every page that mounts this dropdown carries both tabs — À propos renders
  // the manifest, the Contenu tab serves its raw `manifest.json`. That holds for
  // integrations too, which route to `pages/integration-detail.tsx` and have
  // their own tab set: dropping the menu item without a file explorer there
  // left an integration's `manifest.json` and `INTEGRATION.md` reachable only
  // by downloading the `.afps`, so that page mounts the explorer as well.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size={labelledTrigger ? "sm" : "icon"}
          className={labelledTrigger ? "h-8 gap-1.5 px-2.5" : undefined}
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
                {isMutable && (
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
                {canWrite && !isOwned && onFork && (
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
                  <DropdownMenuItem onSelect={onRunWithOptions}>
                    <SlidersHorizontal size={14} />
                    {t("run.options.menuItem")}
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
                {onDownloadBundle && (
                  <DropdownMenuItem
                    onSelect={() => hasPublishedVersion && onDownloadBundle(downloadVersion)}
                    disabled={!hasPublishedVersion}
                    title={!hasPublishedVersion ? t("bundle.requiresVersion") : undefined}
                  >
                    <Package size={14} />
                    {t("bundle.download")}
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
                {hasRuns && onDeleteRuns && (
                  <DropdownMenuItem
                    onSelect={onDeleteRuns}
                    disabled={runningRuns > 0}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 size={14} />
                    {t("detail.clearRuns")}
                  </DropdownMenuItem>
                )}
                {hasMemories && onDeleteMemories && (
                  <DropdownMenuItem
                    onSelect={onDeleteMemories}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 size={14} />
                    {t("detail.clearMemories")}
                  </DropdownMenuItem>
                )}
                {canUninstall && onUninstall && (
                  <DropdownMenuItem
                    onSelect={onUninstall}
                    className="text-destructive focus:text-destructive"
                  >
                    <PackageMinus size={14} />
                    {t("packages.uninstall", { ns: "settings" })}
                  </DropdownMenuItem>
                )}
                {!isBuiltIn && isOwned && onDeleteAgent && (
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
            {downloadVersion && onDownload && (
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
            {isMutable && (
              <DropdownMenuItem
                onSelect={() => (onEdit ? onEdit() : navigate(packageEditPath(type, packageId)))}
              >
                <Pencil size={14} />
                {editLabel ?? t("btn.edit")}
              </DropdownMenuItem>
            )}
            {canWrite && !isOwned && onFork && (
              <DropdownMenuItem onSelect={onFork}>
                <GitFork size={14} />
                {t("fork.button")}
              </DropdownMenuItem>
            )}
            {(showDeactivate || showUninstall || showDelete) && (
              <>
                <DropdownMenuSeparator />
                {canDeactivate && onDeactivate && (
                  <DropdownMenuItem onSelect={onDeactivate} disabled={deactivatePending}>
                    <PowerOff size={14} />
                    {t("integrations.btn.deactivate", { ns: "settings" })}
                  </DropdownMenuItem>
                )}
                {canUninstall && onUninstall && (
                  <DropdownMenuItem
                    onSelect={onUninstall}
                    className="text-destructive focus:text-destructive"
                  >
                    <PackageMinus size={14} />
                    {t("packages.uninstall", { ns: "settings" })}
                  </DropdownMenuItem>
                )}
                {!isBuiltIn && isOwned && canDeletePackage && onDeletePackage && (
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
  );
}
