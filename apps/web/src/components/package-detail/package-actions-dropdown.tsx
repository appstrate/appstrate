// SPDX-License-Identifier: Apache-2.0

import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  Download,
  Package,
  GitBranchPlus,
  GitFork,
  CalendarPlus,
  Trash2,
  PackageMinus,
  PackageX,
  PackagePlus,
  SlidersHorizontal,
  FolderInput,
  Share2,
  Library,
} from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@appstrate/ui/components/dropdown-menu";
import { PageActionsMenu } from "../page-actions-menu";
import type { PackageType } from "@appstrate/core/validation";
import { schemaHasFileFields } from "@appstrate/core/form";
import type { AgentDetail, OrgPackageItemDetail } from "@appstrate/shared-types";
import { packagePermission } from "@appstrate/core/permissions";
import { usePermissions } from "../../hooks/use-permissions";
import { useDeletePackage } from "../../hooks/use-packages";
import { usePackageActivation } from "../../hooks/use-library";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { useSpaceLabelOf } from "../../hooks/use-spaces";
import { splitPackageRef } from "../../lib/package-paths";
import { catalogueHref } from "../../lib/catalogue-link";
import { ConfirmModal } from "../confirm-modal";
import { RemoveFromSpaceConfirm } from "../remove-from-space-confirm";
import { ForkPackageModal } from "../fork-package-modal";
import { isOwnedSource } from "./owned-source";
import { MoveHomeSpaceDialog } from "./move-home-space-dialog";
import { SharePackageDialog, SHARE_PARAM } from "./share-package-dialog";
import { useUrlModal } from "../../hooks/use-url-modal";
import { useCatalogueEntry } from "./catalogue-link";
import { menuSections, type PackageMenuEntry, type PackageMenuGroup } from "./package-menu";

const GROUP_LABELS: Record<PackageMenuGroup, string> = {
  build: "detail.actions.agent",
  execution: "detail.actions.execution",
  export: "detail.actions.export",
  administration: "detail.actions.administration",
};

/** What the menu reads off the detail response: the home verdicts gating each act, and the facts confirmations name. `agents` exists on the non-agent shape only. */
type PackageActionsDetail = Pick<
  AgentDetail,
  | "source"
  | "display_name"
  | "home_space_id"
  | "home_writable"
  | "home_deletable"
  | "home_shareable"
> &
  Partial<Pick<AgentDetail, "running_runs" | "last_run" | "version_count" | "input">> &
  Partial<Pick<OrgPackageItemDetail, "name" | "agents">>;

/** What an agent's menu adds to a package's: its deeds, which the agent page confirms or opens itself. */
interface AgentMenu {
  hasMemories: boolean;
  /** Export the full transitive bundle (.afps-bundle). */
  onDownloadBundle?: (version?: string) => void;
  onDeleteAgent: () => void;
  onDeleteRuns: () => void;
  onDeleteMemories: () => void;
  onAddSchedule: () => void;
  /** Open the advanced run launcher (per-run overrides). */
  onRunWithOptions: () => void;
  /** Why this caller cannot launch at all (never published, working copy not theirs, unsaved edits), translated. */
  runBlockedReason?: string;
}

interface PackageActionsDropdownProps {
  packageId: string;
  type: PackageType;
  /** `undefined` while the detail is loading, which every gate reads as "no". */
  detail: PackageActionsDetail | undefined;
  isHistoricalVersion: boolean;
  downloadVersion?: string;
  onDownload?: (version: string) => void;
  /**
   * ACTIVE in the current space; `undefined` (unknown) offers neither switch. Bundle export runs the
   * execution gate (`isPackageActiveHere`), so a package placed but switched off answers 404.
   */
  isActiveHere?: boolean;
  onCreateVersion?: () => void;
  /** Why « Créer une version » is held back, already translated; `undefined` when it is not. */
  createVersionBlockedReason?: string;
  /** The published version the catalogue sheet opens on; absent, the package as the reader sees it. */
  catalogueVersion?: string;
  agent?: AgentMenu;
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
  isActiveHere,
  onCreateVersion,
  createVersionBlockedReason,
  catalogueVersion,
  agent,
}: PackageActionsDropdownProps) {
  const { t } = useTranslation(["agents", "common", "settings"]);
  const { can } = usePermissions();
  const activation = usePackageActivation(packageId);
  const deletePkg = useDeletePackage(type);
  const [movingHome, setMovingHome] = useState(false);
  const [forking, setForking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const spaceId = useCurrentSpaceId();
  const spaceLabelOf = useSpaceLabelOf();
  const share = useUrlModal(SHARE_PARAM);
  const navigate = useNavigate();
  const catalogue = useCatalogueEntry(type, packageId, catalogueVersion);
  // `confirm` keeps its value while the dialog fades out, so the wording does not change under it.
  const [confirm, setConfirm] = useState<"delete" | "deactivate">("delete");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const askConfirm = (kind: "delete" | "deactivate") => {
    setConfirm(kind);
    setConfirmOpen(true);
  };

  const isOwned = isOwnedSource(detail?.source);
  const displayName = detail?.display_name || detail?.name || packageId;

  // The server's own verdict, not a re-derivation of it.
  const canWrite = detail?.home_writable === true;
  const isMutable = canWrite && !isHistoricalVersion && isOwned;
  // Sharing is a third verb on the home space; a system package answers `false`.
  const canShare = detail?.home_shareable === true && !isHistoricalVersion && isOwned;
  // Whether activation EXISTS follows the package's state here; `usePackageActivation` says whether
  // this caller may perform it (the target space's verdict, not the org∪space union `can` computes, §3.6).
  const showDeactivate = isActiveHere === true && activation.mayDeactivate;
  const showActivate = isActiveHere === false && activation.mayActivate;
  // `delete` is an independent permission, and a custom role may grant `write` without it.
  const showDelete = isOwned && detail?.home_deletable === true;
  // Forking writes a NEW package in the current space, so it asks the current space's write.
  const showFork = can(packagePermission(type, "write")) && !isOwned;
  // The exports need `<type>:read`, which a summary-only caller (an `agents:run` runner) lacks.
  const canRead = can(packagePermission(type, "read"));
  const canExport = canRead && !!downloadVersion && !!onDownload;
  const running = detail?.running_runs ?? 0;
  const hasFileInput = !!schemaHasFileFields(detail?.input?.schema);
  const published = (detail?.version_count ?? 0) > 0;

  const entries: PackageMenuEntry[] = [
    {
      id: "catalogue",
      group: "build",
      icon: Library,
      label: catalogue?.label ?? "",
      hidden: !catalogue,
      onSelect: () => catalogue && navigate(catalogue.to, { state: catalogue.state }),
    },
    {
      id: "download",
      group: agent ? "export" : "build",
      icon: Download,
      label: t("btn.download", { ns: "common" }),
      hidden: !canExport,
      onSelect: () => onDownload?.(downloadVersion!),
    },
    {
      id: "create-version",
      group: "build",
      icon: GitBranchPlus,
      label: t("version.createVersion"),
      reason: createVersionBlockedReason,
      hidden: !isMutable || !onCreateVersion,
      onSelect: onCreateVersion,
    },
    {
      id: "fork",
      group: "build",
      icon: GitFork,
      label: t("fork.button"),
      hidden: !showFork,
      onSelect: () => setForking(true),
    },
    {
      id: "run-options",
      group: "execution",
      icon: SlidersHorizontal,
      label: t("run.options.menuItem"),
      reason: agent?.runBlockedReason,
      hidden: !agent || !can("agents:run"),
      onSelect: agent?.onRunWithOptions,
    },
    {
      id: "schedule",
      group: "execution",
      icon: CalendarPlus,
      label: t("schedule.titleNew"),
      hidden: !agent || !can("schedules:write") || hasFileInput,
      onSelect: agent?.onAddSchedule,
    },
    {
      id: "bundle",
      group: "export",
      icon: Package,
      label: t("bundle.download"),
      reason: published ? undefined : t("bundle.requiresVersion"),
      hidden: !agent?.onDownloadBundle || !canRead || !isActiveHere,
      onSelect: () => agent?.onDownloadBundle?.(downloadVersion),
    },
    {
      id: "clear-runs",
      group: "administration",
      icon: Trash2,
      label: t("detail.clearRuns"),
      destructive: true,
      disabled: running > 0,
      // Clearing runs deletes every member's runs, so the route asks `runs:read-all` on top of `runs:delete`.
      hidden: !agent || !can("runs:delete") || !can("runs:read-all") || !detail?.last_run,
      onSelect: agent?.onDeleteRuns,
    },
    {
      id: "clear-memories",
      group: "administration",
      icon: Trash2,
      label: t("detail.clearMemories"),
      destructive: true,
      hidden: !agent?.hasMemories || !can("persistence:delete"),
      onSelect: agent?.onDeleteMemories,
    },
    // Placement: moving the home is the edit authority, sharing a verb of its own (RBAC §6.10).
    {
      id: "activate",
      group: "administration",
      icon: PackagePlus,
      label: t("packages.activate", { ns: "settings" }),
      disabled: activation.pending,
      hidden: !showActivate,
      onSelect: () => activation.activate(),
    },
    {
      id: "deactivate",
      group: "administration",
      icon: PackageMinus,
      label: t("packages.deactivate", { ns: "settings" }),
      disabled: activation.pending,
      hidden: !showDeactivate,
      onSelect: () => askConfirm("deactivate"),
    },
    {
      id: "remove-here",
      group: "administration",
      icon: PackageX,
      label: t("catalogue.removeHere", { ns: "settings" }),
      destructive: true,
      hidden: !activation.mayRemove,
      onSelect: () => setRemoving(true),
    },
    {
      id: "move-home",
      group: "administration",
      icon: FolderInput,
      label: t("packages.moveHome", { ns: "settings" }),
      hidden: !isMutable,
      onSelect: () => setMovingHome(true),
    },
    {
      id: "share",
      group: "administration",
      icon: Share2,
      label: t("packages.share", { ns: "settings" }),
      hidden: !canShare,
      onSelect: () => share.open(packageId),
    },
    {
      id: "delete",
      group: "administration",
      icon: Trash2,
      label: t("btn.delete"),
      destructive: true,
      disabled: running > 0,
      // Deleting a skill, MCP server or integration an agent still uses is refused; an agent's own deletion is its page's confirmation.
      hidden: !showDelete || (!agent && detail?.agents?.length !== 0),
      onSelect: agent ? agent.onDeleteAgent : () => askConfirm("delete"),
    },
  ];
  const sections = menuSections(entries);

  return (
    <>
      <PageActionsMenu contentClassName={agent ? "min-w-64" : undefined}>
        {sections.map(({ group, entries: items }, index) => (
          <Fragment key={group}>
            {index > 0 && <DropdownMenuSeparator />}
            {agent && <DropdownMenuLabel>{t(GROUP_LABELS[group])}</DropdownMenuLabel>}
            {items.map((entry) => (
              <DropdownMenuItem
                key={entry.id}
                disabled={entry.disabled || !!entry.reason}
                onSelect={entry.onSelect}
                className={cn(entry.destructive && "text-destructive focus:text-destructive")}
              >
                <entry.icon />
                <DisabledItemLabel label={entry.label} reason={entry.reason} />
              </DropdownMenuItem>
            ))}
          </Fragment>
        ))}
      </PageActionsMenu>

      {/* Mounted only while open: any way of closing a form modal abandons its input. */}
      {movingHome && isMutable && (
        <MoveHomeSpaceDialog
          onClose={() => setMovingHome(false)}
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
            share.close();
            setMovingHome(true);
          }}
        />
      )}
      {forking && showFork && (
        <ForkPackageModal
          onClose={() => setForking(false)}
          packageId={packageId}
          defaultName={splitPackageRef(packageId).name}
          type={type}
        />
      )}

      <RemoveFromSpaceConfirm
        target={
          removing && spaceId
            ? {
                packageId,
                name: displayName,
                spaceId,
                spaceName: spaceLabelOf(spaceId) ?? spaceId,
              }
            : null
        }
        onClose={() => setRemoving(false)}
        // The package page is read from the space it was just taken out of: leave for the catalogue.
        onRemoved={() => navigate(catalogueHref(type))}
      />

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
