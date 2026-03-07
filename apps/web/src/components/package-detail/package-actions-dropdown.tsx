import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  MoreHorizontal,
  Download,
  Settings,
  GitBranchPlus,
  Pencil,
  CalendarPlus,
  Trash2,
  Link2,
  Globe,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { api } from "../../api";

interface PackageActionsDropdownProps {
  packageId: string;
  type: "flow" | "skill" | "extension";
  isOrgAdmin: boolean;
  isBuiltIn: boolean;
  isHistoricalVersion: boolean;
  hasDraftChanges: boolean;
  downloadVersion?: string;
  onDownload?: (version: string) => void;
  onCreateVersion?: () => void;
  // Flow-specific
  hasConfigSchema?: boolean;
  onConfigure?: () => void;
  runningExecutions?: number;
  hasExecutions?: boolean;
  hasMemories?: boolean;
  hasFileInput?: boolean;
  onDeleteFlow?: () => void;
  onDeleteExecutions?: () => void;
  onAddSchedule?: () => void;
  onDeleteMemories?: () => void;
  // Skill/Extension-specific
  canDeletePackage?: boolean;
  onDeletePackage?: () => void;
  // Share (flow-only)
  shareServices?: Array<{
    id: string;
    connectionMode?: string;
    status: string;
    adminProvided?: boolean;
  }>;
}

export function PackageActionsDropdown({
  packageId,
  type,
  isOrgAdmin,
  isBuiltIn,
  isHistoricalVersion,
  hasDraftChanges,
  downloadVersion,
  onDownload,
  onCreateVersion,
  hasConfigSchema,
  onConfigure,
  runningExecutions = 0,
  hasExecutions,
  hasMemories,
  hasFileInput,
  onDeleteFlow,
  onDeleteExecutions,
  onAddSchedule,
  onDeleteMemories,
  canDeletePackage,
  onDeletePackage,
  shareServices,
}: PackageActionsDropdownProps) {
  const { t } = useTranslation(["flows", "common", "settings"]);
  const navigate = useNavigate();
  const [shareCopied, setShareCopied] = useState(false);
  const [shareGenerating, setShareGenerating] = useState(false);

  const isFlow = type === "flow";
  const isMutable = !isBuiltIn && !isHistoricalVersion;

  // Share logic (flow-only)
  const copyShareLink = () => {
    const url = `${window.location.origin}/flows/${packageId}/run`;
    navigator.clipboard.writeText(url).then(() => {
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    });
  };

  const canSharePublic =
    shareServices &&
    (shareServices.length === 0 ||
      shareServices.every(
        (s) =>
          (s.connectionMode ?? "user") === "admin" && s.adminProvided && s.status === "connected",
      ));

  const generatePublicLink = async () => {
    setShareGenerating(true);
    try {
      const data = await api<{ token: string }>(`/flows/${packageId}/share-token`, {
        method: "POST",
      });
      const url = `${window.location.origin}/share/${data.token}`;
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch (err) {
      alert(err instanceof Error ? err.message : t("share.errorGenerate"));
    } finally {
      setShareGenerating(false);
    }
  };

  // Nothing to show for non-admin on non-flow packages
  if (!isOrgAdmin && !isFlow) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon">
          <MoreHorizontal size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* ── Share (flow-only) ── */}
        {isFlow && (
          <>
            <DropdownMenuItem onSelect={copyShareLink}>
              <Link2 size={14} />
              {shareCopied ? t("share.copied") : t("share.copyLink")}
            </DropdownMenuItem>
            {isOrgAdmin && (
              <DropdownMenuItem
                onSelect={generatePublicLink}
                disabled={!canSharePublic || shareGenerating}
              >
                <Globe size={14} />
                {shareGenerating ? t("share.generating") : t("share.publicLink")}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
          </>
        )}

        {/* ── Configure (flow-only, if configSchema) ── */}
        {isFlow && hasConfigSchema && onConfigure && (
          <DropdownMenuItem onSelect={onConfigure}>
            <Settings size={14} />
            {t("detail.configure")}
          </DropdownMenuItem>
        )}

        {/* ── Download ── */}
        {isOrgAdmin && downloadVersion && onDownload && (
          <DropdownMenuItem onSelect={() => onDownload(downloadVersion)}>
            <Download size={14} />
            {t("btn.download", { ns: "common" })}
          </DropdownMenuItem>
        )}

        {/* ── Create version ── */}
        {isOrgAdmin && isMutable && onCreateVersion && (
          <DropdownMenuItem onSelect={onCreateVersion} disabled={!hasDraftChanges}>
            <GitBranchPlus size={14} />
            {t("version.createVersion")}
          </DropdownMenuItem>
        )}

        {/* ── Edit ── */}
        {isOrgAdmin && isMutable && (
          <DropdownMenuItem onSelect={() => navigate(`/${type}s/${packageId}/edit`)}>
            <Pencil size={14} />
            {t("btn.edit")}
          </DropdownMenuItem>
        )}

        {/* ── Flow secondary actions ── */}
        {isFlow && isOrgAdmin && (
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

        {/* ── Delete ── */}
        {isOrgAdmin && !isBuiltIn && (
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
  );
}
