// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
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
import type { PackageType } from "@appstrate/core/validation";
import type { AgentDetail, OrgPackageItemDetail } from "@appstrate/shared-types";
import { packagePermission } from "@appstrate/core/permissions";
import { usePermissions } from "../../hooks/use-permissions";
import { useDeletePackage } from "../../hooks/use-packages";
import { usePackageActivation, usePackageActivationInSpaces } from "../../hooks/use-library";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { useOverviewMode } from "../../hooks/use-overview-mode";
import { useSpaceAction } from "../../hooks/use-space-action";
import { useSpaceLabelOf, useSpaces } from "../../hooks/use-spaces";
import { useUrlModal } from "../../hooks/use-url-modal";
import { spaceLabel } from "../../lib/space-label";
import { splitPackageRef } from "../../lib/package-paths";
import { catalogueHref } from "../../lib/catalogue-link";
import { agentCreationWithIntegrationPath } from "../../lib/creation-handoff";
import { PACKAGE_TYPE_ICON } from "../../lib/package-type-icon";
import { ConfirmModal } from "../confirm-modal";
import { RemoveFromSpaceConfirm } from "../remove-from-space-confirm";
import { ForkPackageModal } from "../fork-package-modal";
import { isOwnedSource } from "./owned-source";
import { MoveHomeSpaceDialog } from "./move-home-space-dialog";
import { SharePackageDialog, SHARE_PARAM } from "./share-package-dialog";
import { useCatalogueEntry } from "./catalogue-link";
import { menuSections, type PackageMenuEntry } from "./package-menu";
import { deedInSpaces, deedOfAction, type SpaceDeed } from "./space-deed";

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
  Partial<Pick<AgentDetail, "running_runs" | "version_count">> &
  Partial<Pick<OrgPackageItemDetail, "name" | "agents">>;

/** What an agent's menu adds to a package's: its deeds, each acting in a space, which the agent page confirms or opens itself. */
interface AgentMenu {
  /** Open the advanced run launcher (per-run overrides). */
  runWithOptions: SpaceDeed;
  /** Why this caller cannot launch at all (never published, working copy not theirs, unsaved edits), translated. */
  runBlockedReason?: string;
  addSchedule: SpaceDeed;
  /** Export the full transitive bundle (.afps-bundle). */
  bundle: SpaceDeed;
  clearRuns: SpaceDeed;
  clearMemories: SpaceDeed;
  onDeleteAgent: () => void;
}

export interface PackageActionsDropdownProps {
  packageId: string;
  type: PackageType;
  /** `undefined` while the detail is loading, which every gate reads as "no". */
  detail: PackageActionsDetail | undefined;
  isHistoricalVersion: boolean;
  downloadVersion?: string;
  onDownload?: (version: string) => void;
  /** ACTIVE in the working space; `undefined` (unknown) offers neither switch there. */
  isActiveHere?: boolean;
  onCreateVersion?: () => void;
  /** Why « Créer une version » is held back, already translated; `undefined` when it is not. */
  createVersionBlockedReason?: string;
  /** The published version the catalogue sheet opens on; absent, the package as the reader sees it. */
  catalogueVersion?: string;
  agent?: AgentMenu;
}

/** The entry's fields its space deed decides; `label` only when the deed names its space. */
function fromDeed(deed: SpaceDeed | undefined) {
  return {
    hidden: !deed?.offered,
    disabled: deed?.disabled,
    onSelect: deed?.onSelect,
    inSpaces: deed?.inSpaces,
    ...(deed?.label ? { label: deed.label } : {}),
  };
}

/**
 * The menu's sections and the dialogs its entries open. With a working space every deed acts
 * there; in « Tous les espaces » a deed naming no space asks it (`SpaceDeed`).
 */
export function usePackageActions({
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
  const { on: overview } = useOverviewMode();
  const activation = usePackageActivation(packageId);
  const across = usePackageActivationInSpaces(packageId, { enabled: overview });
  const deletePkg = useDeletePackage(type);
  const [movingHome, setMovingHome] = useState(false);
  const [forking, setForking] = useState(false);
  // The space each act targets, kept while its dialog fades out.
  const [removing, setRemoving] = useState<string | null>(null);
  const [deactivating, setDeactivating] = useState<string | null>(null);
  const spaceId = useCurrentSpaceId();
  const spaceLabelOf = useSpaceLabelOf();
  const { data: spaces } = useSpaces();
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
  const askDeactivate = (targetSpaceId: string) => {
    setDeactivating(targetSpaceId);
    askConfirm("deactivate");
  };

  const isOwned = isOwnedSource(detail?.source);
  const displayName = detail?.display_name || detail?.name || packageId;

  // The server's own verdict, not a re-derivation of it.
  const canWrite = detail?.home_writable === true;
  const isMutable = canWrite && !isHistoricalVersion && isOwned;
  // Sharing is a third verb on the home space; a system package answers `false`.
  const canShare = detail?.home_shareable === true && !isHistoricalVersion && isOwned;
  // `delete` is an independent permission, and a custom role may grant `write` without it.
  const showDelete = isOwned && detail?.home_deletable === true;
  // Forking writes a NEW package in the space it is made in: one where the reader writes the type.
  const forkAction = useSpaceAction({ permission: packagePermission(type, "write") });
  const showFork = forkAction.offered && !isOwned;
  // The export needs `<type>:read`, which a summary-only caller (an `agents:run` runner) lacks.
  const canExport = can(packagePermission(type, "read")) && !!downloadVersion && !!onDownload;
  const running = detail?.running_runs ?? 0;
  const published = (detail?.version_count ?? 0) > 0;

  // Placement deeds. With a working space they follow the package's state there, and
  // `usePackageActivation` says whether this caller may perform them (the target space's verdict,
  // not the org∪space union `can` computes, §3.6). In « Tous les espaces » each asks its space
  // among those the organization library grades for it.
  const spacesOf = (ids: readonly string[]) =>
    ids.flatMap((id) => spaces?.find((space) => space.id === id) ?? []);
  const naming = (key: string) => (space: Parameters<typeof spaceLabel>[0]) =>
    t(key, { ns: "common", space: spaceLabel(space, t) });
  const activate: SpaceDeed = overview
    ? {
        ...deedInSpaces(
          spacesOf(across.activateIn),
          { menu: t("common:spaceChoice.activate"), one: naming("spaceChoice.activateIn") },
          (target) => across.setActive(target, true),
        ),
        disabled: across.pending,
      }
    : {
        offered: isActiveHere === false && activation.mayActivate,
        disabled: activation.pending,
        onSelect: () => activation.activate(),
      };
  const deactivate: SpaceDeed = overview
    ? {
        ...deedInSpaces(
          spacesOf(across.deactivateIn),
          { menu: t("common:spaceChoice.deactivate"), one: naming("spaceChoice.deactivateIn") },
          askDeactivate,
        ),
        disabled: across.pending,
      }
    : {
        offered: isActiveHere === true && activation.mayDeactivate && !!spaceId,
        disabled: activation.pending,
        onSelect: () => spaceId && askDeactivate(spaceId),
      };
  const remove: SpaceDeed = overview
    ? deedInSpaces(
        spacesOf(across.removeFrom),
        { menu: t("common:spaceChoice.remove"), one: naming("spaceChoice.removeFrom") },
        setRemoving,
      )
    : { offered: activation.mayRemove && !!spaceId, onSelect: () => setRemoving(spaceId) };

  const entries: PackageMenuEntry[] = [
    {
      id: "use-in-agent",
      group: "build",
      icon: PACKAGE_TYPE_ICON.agent,
      label: t("integrationWizard.ready.useInAgent"),
      // A run resolves an integration's published version, in a space where it is active.
      hidden: type !== "integration" || !published || isActiveHere !== true || !can("agents:write"),
      onSelect: () => navigate(agentCreationWithIntegrationPath(packageId)),
    },
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
      ...fromDeed(deedOfAction(forkAction, t("common:spaceChoice.fork"), () => setForking(true))),
      hidden: !showFork,
    },
    {
      id: "run-options",
      group: "execution",
      icon: SlidersHorizontal,
      label: t("run.options.menuItem"),
      reason: agent?.runBlockedReason,
      ...fromDeed(agent?.runWithOptions),
    },
    {
      id: "schedule",
      group: "execution",
      icon: CalendarPlus,
      label: t("schedule.titleNew"),
      ...fromDeed(agent?.addSchedule),
    },
    {
      id: "bundle",
      group: "export",
      icon: Package,
      label: t("bundle.download"),
      reason: published ? undefined : t("bundle.requiresVersion"),
      ...fromDeed(agent?.bundle),
    },
    {
      id: "clear-runs",
      group: "administration",
      icon: Trash2,
      label: t("detail.clearRuns"),
      destructive: true,
      ...fromDeed(agent?.clearRuns),
    },
    {
      id: "clear-memories",
      group: "administration",
      icon: Trash2,
      label: t("detail.clearMemories"),
      destructive: true,
      ...fromDeed(agent?.clearMemories),
    },
    // Placement: moving the home is the edit authority, sharing a verb of its own (RBAC §6.10).
    {
      id: "activate",
      group: "administration",
      icon: PackagePlus,
      label: t("packages.activate", { ns: "settings" }),
      ...fromDeed(activate),
    },
    {
      id: "deactivate",
      group: "administration",
      icon: PackageMinus,
      label: t("packages.deactivate", { ns: "settings" }),
      ...fromDeed(deactivate),
    },
    {
      id: "remove-here",
      group: "administration",
      icon: PackageX,
      label: t("catalogue.removeHere", { ns: "settings" }),
      destructive: true,
      ...fromDeed(remove),
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
  const deactivatingLabel = deactivating ? (spaceLabelOf(deactivating) ?? deactivating) : "";

  const dialogs = (
    <>
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
        removal={
          removing
            ? {
                packageId,
                name: displayName,
                target: removing,
                targetLabel: spaceLabelOf(removing) ?? removing,
              }
            : null
        }
        onClose={() => setRemoving(null)}
        // Taken out of the space the page is read from: leave for the catalogue.
        onRemoved={removing === spaceId ? () => navigate(catalogueHref(type)) : undefined}
      />

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={
          confirm === "deactivate"
            ? t("detail.deactivateTitle", { space: deactivatingLabel })
            : t("detail.deletePackageTitle")
        }
        description={
          confirm === "deactivate"
            ? t("packages.deactivateConfirm", {
                name: displayName,
                space: deactivatingLabel,
                ns: "settings",
              })
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
        isPending={across.pending || deletePkg.isPending}
        onConfirm={() => {
          const onSuccess = () => setConfirmOpen(false);
          if (confirm === "deactivate") {
            if (deactivating) across.setActive(deactivating, false, { onSuccess });
          } else deletePkg.mutate(packageId, { onSuccess });
        }}
      />
    </>
  );

  return { sections, dialogs };
}
