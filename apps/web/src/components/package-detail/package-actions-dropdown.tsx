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
  FileJson,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { PackageType } from "@appstrate/core/validation";
import { Modal } from "../modal";
import { JsonView } from "../json-view";
import { packageEditPath } from "../../lib/package-paths";
import { usePermissions } from "../../hooks/use-permissions";

interface PackageActionsDropdownProps {
  packageId: string;
  type: PackageType;
  manifest?: Record<string, unknown>;
  companionFile?: { name: string; content: string };
  isOwned: boolean;
  isImported?: boolean;
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
  // Agent-specific
  runningRuns?: number;
  hasRuns?: boolean;
  hasMemories?: boolean;
  hasFileInput?: boolean;
  onDeleteAgent?: () => void;
  onDeleteRuns?: () => void;
  onAddSchedule?: () => void;
  onDeleteMemories?: () => void;
  // Provider-specific
  hasCredentials?: boolean;
  onDeleteCredentials?: () => void;
  // Skill/Tool-specific
  canDeletePackage?: boolean;
  onDeletePackage?: () => void;
  // Uninstall from current app
  canUninstall?: boolean;
  onUninstall?: () => void;
}

export function PackageActionsDropdown({
  packageId,
  type,
  manifest,
  companionFile,
  isOwned,
  isImported,
  isBuiltIn,
  isHistoricalVersion,
  downloadVersion,
  onDownload,
  onDownloadBundle,
  hasPublishedVersion,
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
  hasCredentials,
  onDeleteCredentials,
  canDeletePackage,
  onDeletePackage,
  canUninstall,
  onUninstall,
}: PackageActionsDropdownProps) {
  const { t } = useTranslation(["agents", "common", "settings"]);
  const navigate = useNavigate();
  const { isAdmin, isMember } = usePermissions();
  const [manifestOpen, setManifestOpen] = useState(false);
  const [companionOpen, setCompanionOpen] = useState(false);

  const isAgent = type === "agent";
  const isMutable = isAdmin && !isBuiltIn && !isHistoricalVersion && isOwned;
  const hasViewableFiles = !!manifest || !!companionFile;

  if (!isAgent && !hasViewableFiles) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon">
            <MoreHorizontal size={16} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* ── View Manifest ── */}
          {manifest && (
            <DropdownMenuItem onSelect={() => setManifestOpen(true)}>
              <FileJson size={14} />
              {t("viewManifest", { ns: "common" })}
            </DropdownMenuItem>
          )}

          {/* ── Companion File ── */}
          {companionFile && (
            <DropdownMenuItem onSelect={() => setCompanionOpen(true)}>
              <FileText size={14} />
              {companionFile.name}
            </DropdownMenuItem>
          )}

          {hasViewableFiles && <DropdownMenuSeparator />}

          {/* ── Download ── */}
          {downloadVersion && onDownload && (
            <DropdownMenuItem onSelect={() => onDownload(downloadVersion)}>
              <Download size={14} />
              {t("btn.download", { ns: "common" })}
            </DropdownMenuItem>
          )}

          {/* ── Download bundle (agent only — multi-package, transitive).
              Disabled when no version has been published: the export
              endpoint resolves `(packageId, version)` from the registry,
              so a draft-only package would 404. */}
          {isAgent && onDownloadBundle && (
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

          {/* ── Fork (non-owned packages, including system) ── */}
          {isMember && !isOwned && onFork && (
            <DropdownMenuItem onSelect={onFork}>
              <GitFork size={14} />
              {t("fork.button")}
            </DropdownMenuItem>
          )}

          {/* ── Agent secondary actions ── */}
          {isAgent && (
            <>
              <DropdownMenuSeparator />
              {isMember && !hasFileInput && onAddSchedule && (
                <DropdownMenuItem onSelect={onAddSchedule}>
                  <CalendarPlus size={14} />
                  {t("schedule.titleNew")}
                </DropdownMenuItem>
              )}
              {isAdmin && hasRuns && onDeleteRuns && (
                <DropdownMenuItem
                  onSelect={onDeleteRuns}
                  disabled={runningRuns > 0}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 size={14} />
                  {t("detail.clearRuns")}
                </DropdownMenuItem>
              )}
              {isAdmin && hasMemories && onDeleteMemories && (
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

          {/* ── Delete credentials (provider-only) ── */}
          {isAdmin && type === "provider" && hasCredentials && onDeleteCredentials && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={onDeleteCredentials}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 size={14} />
                {t("providers.deleteCredentials", { ns: "settings" })}
              </DropdownMenuItem>
            </>
          )}

          {/* ── Uninstall / Delete ── */}
          {isAdmin && (canUninstall || (!isBuiltIn && (isOwned || isImported))) && (
            <>
              <DropdownMenuSeparator />
              {canUninstall && onUninstall && (
                <DropdownMenuItem
                  onSelect={onUninstall}
                  className="text-destructive focus:text-destructive"
                >
                  <PackageMinus size={14} />
                  {t("packages.uninstall", { ns: "settings" })}
                </DropdownMenuItem>
              )}
              {!isBuiltIn && (isOwned || isImported) && isAgent && onDeleteAgent && (
                <DropdownMenuItem
                  onSelect={onDeleteAgent}
                  disabled={runningRuns > 0}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 size={14} />
                  {t("btn.delete")}
                </DropdownMenuItem>
              )}
              {!isBuiltIn &&
                (isOwned || isImported) &&
                !isAgent &&
                canDeletePackage &&
                onDeletePackage && (
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

      {/* ── Manifest Modal ── */}
      {manifest && (
        <Modal
          open={manifestOpen}
          onClose={() => setManifestOpen(false)}
          title={t("viewManifest", { ns: "common" })}
          className="max-w-2xl"
        >
          <JsonView data={manifest} />
        </Modal>
      )}

      {/* ── Companion File Modal ── */}
      {companionFile && (
        <Modal
          open={companionOpen}
          onClose={() => setCompanionOpen(false)}
          title={companionFile.name}
          className="max-w-2xl"
        >
          <pre className="text-muted-foreground bg-muted/50 overflow-x-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
            {companionFile.content}
          </pre>
        </Modal>
      )}
    </>
  );
}
