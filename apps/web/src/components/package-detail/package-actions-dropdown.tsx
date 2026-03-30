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
import type { PackageType } from "@appstrate/shared-types";
import { Modal } from "../modal";
import { JsonView } from "../json-view";
import { packageEditPath } from "../../lib/package-paths";

interface PackageActionsDropdownProps {
  packageId: string;
  type: PackageType;
  manifest?: Record<string, unknown>;
  isOwned: boolean;
  isBuiltIn: boolean;
  isHistoricalVersion: boolean;
  hasDraftChanges: boolean;
  downloadVersion?: string;
  onDownload?: (version: string) => void;
  onCreateVersion?: () => void;
  onFork?: () => void;
  // Flow-specific
  runningExecutions?: number;
  hasExecutions?: boolean;
  hasMemories?: boolean;
  hasFileInput?: boolean;
  onDeleteFlow?: () => void;
  onDeleteExecutions?: () => void;
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
  isBuiltIn,
  isHistoricalVersion,
  hasDraftChanges,
  downloadVersion,
  onDownload,
  onCreateVersion,
  onFork,
  runningExecutions = 0,
  hasExecutions,
  hasMemories,
  hasFileInput,
  onDeleteFlow,
  onDeleteExecutions,
  onAddSchedule,
  onDeleteMemories,
  hasCredentials,
  onDeleteCredentials,
  canDeletePackage,
  onDeletePackage,
}: PackageActionsDropdownProps) {
  const { t } = useTranslation(["flows", "common", "settings"]);
  const navigate = useNavigate();
  const [definitionOpen, setDefinitionOpen] = useState(false);

  const isFlow = type === "flow";
  const isMutable = !isBuiltIn && !isHistoricalVersion && isOwned;

  if (!isFlow && !manifest) return null;

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
            <DropdownMenuItem onSelect={onCreateVersion} disabled={!hasDraftChanges}>
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
          {!isOwned && onFork && (
            <DropdownMenuItem onSelect={onFork}>
              <GitFork size={14} />
              {t("fork.button")}
            </DropdownMenuItem>
          )}

          {/* ── Flow secondary actions ── */}
          {isFlow && (
            <>
              <DropdownMenuSeparator />
              {!hasFileInput && onAddSchedule && (
                <DropdownMenuItem onSelect={onAddSchedule}>
                  <CalendarPlus size={14} />
                  {t("schedule.titleNew")}
                </DropdownMenuItem>
              )}
              {hasExecutions && onDeleteExecutions && (
                <DropdownMenuItem
                  onSelect={onDeleteExecutions}
                  disabled={runningExecutions > 0}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 size={14} />
                  {t("detail.clearExec")}
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
            </>
          )}

          {/* ── Delete credentials (provider-only) ── */}
          {type === "provider" && hasCredentials && onDeleteCredentials && (
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
          {!isBuiltIn && isOwned && (
            <>
              <DropdownMenuSeparator />
              {isFlow && onDeleteFlow && (
                <DropdownMenuItem
                  onSelect={onDeleteFlow}
                  disabled={runningExecutions > 0}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 size={14} />
                  {t("btn.delete")}
                </DropdownMenuItem>
              )}
              {!isFlow && canDeletePackage && onDeletePackage && (
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
