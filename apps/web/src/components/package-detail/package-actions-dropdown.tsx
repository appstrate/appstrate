// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  MoreHorizontal,
  Download,
  GitBranchPlus,
  GitFork,
  Pencil,
  CalendarPlus,
  Trash2,
  FileJson,
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
  isOwned: boolean;
  isImported?: boolean;
  isBuiltIn: boolean;
  isHistoricalVersion: boolean;
  downloadVersion?: string;
  onDownload?: (version: string) => void;
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
}

export function PackageActionsDropdown({
  packageId,
  type,
  manifest,
  isOwned,
  isImported,
  isBuiltIn,
  isHistoricalVersion,
  downloadVersion,
  onDownload,
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
}: PackageActionsDropdownProps) {
  const { t } = useTranslation(["agents", "common", "settings"]);
  const navigate = useNavigate();
  const { isAdmin, isMember } = usePermissions();
  const [definitionOpen, setDefinitionOpen] = useState(false);

  const isAgent = type === "agent";
  const isMutable = isAdmin && !isBuiltIn && !isHistoricalVersion && isOwned;

  if (!isAgent && !manifest) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon">
            <MoreHorizontal size={16} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* ── View Definition ── */}
          {manifest && (
            <>
              <DropdownMenuItem onSelect={() => setDefinitionOpen(true)}>
                <FileJson size={14} />
                {t("viewDefinition", { ns: "common" })}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}

          {/* ── Download ── */}
          {downloadVersion && onDownload && (
            <DropdownMenuItem onSelect={() => onDownload(downloadVersion)}>
              <Download size={14} />
              {t("btn.download", { ns: "common" })}
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

          {/* ── Delete ── */}
          {isAdmin && !isBuiltIn && (isOwned || isImported) && (
            <>
              <DropdownMenuSeparator />
              {isAgent && onDeleteAgent && (
                <DropdownMenuItem
                  onSelect={onDeleteAgent}
                  disabled={runningRuns > 0}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 size={14} />
                  {t("btn.delete")}
                </DropdownMenuItem>
              )}
              {!isAgent && canDeletePackage && onDeletePackage && (
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
      {manifest && (
        <Modal
          open={definitionOpen}
          onClose={() => setDefinitionOpen(false)}
          title={t("viewDefinition", { ns: "common" })}
          className="max-w-2xl"
        >
          <JsonView data={manifest} />
        </Modal>
      )}
    </>
  );
}
