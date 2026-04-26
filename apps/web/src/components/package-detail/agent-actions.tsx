// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { isFileField } from "@appstrate/core/form";
import { usePackageDetail } from "../../hooks/use-packages";
import { useRuns } from "../../hooks/use-runs";
import { useAgentMemories } from "../../hooks/use-persistence";
import {
  useDeleteAgent,
  useDeleteAgentRuns,
  useDeleteAllMemories,
} from "../../hooks/use-mutations";
import { usePackageInstallState, useTogglePackageInstall } from "../../hooks/use-library";
import { useCurrentApplicationId } from "../../hooks/use-current-application";
import { PackageActionsDropdown } from "./package-actions-dropdown";
import { ConfirmModal } from "../confirm-modal";

export function AgentActions({
  packageId,
  manifest,
  companionFile,
  isOwned,
  isImported,
  isHistoricalVersion,
  downloadVersion,
  downloadPackage,
  downloadBundle,
  onCreateVersion,
  onFork,
}: {
  packageId: string;
  manifest?: Record<string, unknown>;
  companionFile?: { name: string; content: string };
  isOwned: boolean;
  isImported?: boolean;
  isHistoricalVersion: boolean;
  downloadVersion: string | undefined;
  downloadPackage: (v: string) => void;
  /** Export the agent + transitive deps as a single .afps-bundle. */
  downloadBundle?: (v?: string) => void;
  onCreateVersion: () => void;
  onFork?: () => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const navigate = useNavigate();
  const { data: detail } = usePackageDetail("agent", packageId);
  const { data: runs } = useRuns(packageId);
  const { data: memories } = useAgentMemories(packageId);
  const deleteAgent = useDeleteAgent();
  const deleteRuns = useDeleteAgentRuns(packageId);
  const deleteAllMemories = useDeleteAllMemories(packageId);
  const uninstallMutation = useTogglePackageInstall();
  const currentAppId = useCurrentApplicationId();
  const { installedAppNames, isInstalledInCurrentApp } = usePackageInstallState(packageId);

  const [confirmState, setConfirmState] = useState<{
    type: "deleteAgent" | "clearRuns" | "clearMemories" | "uninstallAgent";
    label: string;
  } | null>(null);

  if (!detail) return null;

  const hasFileInput =
    detail.input?.schema?.properties &&
    Object.values(detail.input.schema.properties).some(isFileField);

  const handleConfirm = () => {
    if (!confirmState) return;
    const onSuccess = () => setConfirmState(null);
    switch (confirmState.type) {
      case "deleteAgent":
        deleteAgent.mutate(detail.id, { onSuccess });
        break;
      case "clearRuns":
        deleteRuns.mutate(undefined, { onSuccess });
        break;
      case "clearMemories":
        deleteAllMemories.mutate(undefined, { onSuccess });
        break;
      case "uninstallAgent":
        if (!currentAppId) return;
        uninstallMutation.mutate(
          { appId: currentAppId, packageId, installed: true },
          { onSuccess },
        );
        break;
    }
  };

  return (
    <>
      <PackageActionsDropdown
        packageId={packageId}
        type="agent"
        manifest={manifest}
        companionFile={companionFile}
        isOwned={isOwned}
        isImported={isImported}
        isBuiltIn={detail.source === "system"}
        isHistoricalVersion={isHistoricalVersion}
        downloadVersion={downloadVersion}
        onDownload={downloadPackage}
        onDownloadBundle={downloadBundle}
        hasPublishedVersion={(detail.versionCount ?? 0) > 0}
        onCreateVersion={onCreateVersion}
        onFork={onFork}
        runningRuns={detail.runningRuns}
        hasRuns={!!runs && runs.length > 0}
        hasMemories={!!memories && memories.length > 0}
        hasFileInput={!!hasFileInput}
        onDeleteAgent={() =>
          setConfirmState({
            type: "deleteAgent",
            label:
              installedAppNames.length > 0
                ? t("detail.deleteConfirmWithApps", {
                    name: detail.displayName,
                    apps: installedAppNames.join(", "),
                  })
                : t("detail.deleteConfirm", { name: detail.displayName }),
          })
        }
        canUninstall={isInstalledInCurrentApp && detail.source !== "system"}
        onUninstall={() =>
          setConfirmState({
            type: "uninstallAgent",
            label: t("packages.uninstallConfirm", {
              name: detail.displayName,
              ns: "settings",
            }),
          })
        }
        onDeleteRuns={() =>
          setConfirmState({
            type: "clearRuns",
            label: t("detail.clearRunsConfirm"),
          })
        }
        onAddSchedule={() => navigate("/schedules/new")}
        onDeleteMemories={() =>
          setConfirmState({
            type: "clearMemories",
            label: t("detail.clearMemoriesConfirm"),
          })
        }
      />
      <ConfirmModal
        open={confirmState !== null}
        onClose={() => setConfirmState(null)}
        onConfirm={handleConfirm}
        title={t("btn.confirm", { ns: "common" })}
        description={confirmState?.label ?? ""}
        confirmLabel={
          confirmState?.type === "uninstallAgent"
            ? t("packages.uninstall", { ns: "settings" })
            : undefined
        }
        isPending={
          deleteAgent.isPending ||
          deleteRuns.isPending ||
          deleteAllMemories.isPending ||
          uninstallMutation.isPending
        }
      />
    </>
  );
}
