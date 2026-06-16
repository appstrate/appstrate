// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { schemaHasFileFields } from "@appstrate/core/form";
import { usePackageDetail } from "../../hooks/use-packages";
import { useRuns } from "../../hooks/use-runs";
import { useAgentMemories } from "../../hooks/use-persistence";
import {
  useDeleteAgent,
  useDeleteAgentRuns,
  useDeleteAllMemories,
  useRunAgent,
} from "../../hooks/use-mutations";
import { usePackageInstallState, useTogglePackageInstall } from "../../hooks/use-library";
import { useCurrentApplicationId } from "../../hooks/use-current-application";
import { PackageActionsDropdown } from "./package-actions-dropdown";
import { ConfirmModal } from "../confirm-modal";
import { RunWithOptionsModal } from "../run-with-options-modal";

export function AgentActions({
  packageId,
  manifest,
  companionFile,
  isOwned,
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
  const runAgent = useRunAgent(packageId);
  const currentAppId = useCurrentApplicationId();
  const { installedAppNames, isInstalledInCurrentApp } = usePackageInstallState(packageId);

  const [confirmState, setConfirmState] = useState<{
    type: "deleteAgent" | "clearRuns" | "clearMemories" | "uninstallAgent";
    label: string;
  } | null>(null);
  const [runOptionsOpen, setRunOptionsOpen] = useState(false);

  if (!detail) return null;

  const hasFileInput = schemaHasFileFields(detail.input?.schema);

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
          { applicationId: currentAppId, packageId, installed: true },
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
        isBuiltIn={detail.source === "system"}
        isHistoricalVersion={isHistoricalVersion}
        downloadVersion={downloadVersion}
        onDownload={downloadPackage}
        onDownloadBundle={downloadBundle}
        hasPublishedVersion={(detail.version_count ?? 0) > 0}
        onCreateVersion={onCreateVersion}
        onFork={onFork}
        runningRuns={detail.running_runs}
        hasRuns={!!runs && runs.length > 0}
        hasMemories={!!memories && memories.length > 0}
        hasFileInput={!!hasFileInput}
        onDeleteAgent={() =>
          setConfirmState({
            type: "deleteAgent",
            label:
              installedAppNames.length > 0
                ? t("detail.deleteConfirmWithApps", {
                    name: detail.display_name,
                    apps: installedAppNames.join(", "),
                  })
                : t("detail.deleteConfirm", { name: detail.display_name }),
          })
        }
        canUninstall={isInstalledInCurrentApp && detail.source !== "system"}
        onUninstall={() =>
          setConfirmState({
            type: "uninstallAgent",
            label: t("packages.uninstallConfirm", {
              name: detail.display_name,
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
        onRunWithOptions={() => setRunOptionsOpen(true)}
      />
      <RunWithOptionsModal
        open={runOptionsOpen}
        onClose={() => setRunOptionsOpen(false)}
        agent={detail}
        isPending={runAgent.isPending}
        onSubmit={({ input, overrides, dependencyOverrides }) => {
          // Map the schedule-shaped override delta onto the run API body.
          // `version_override` rides the `?version=` query; the proxy "none"
          // sentinel (`__none__`) becomes the server's `"none"` (no proxy).
          const proxy = overrides.proxy_id_override;
          runAgent.mutate(
            {
              ...(Object.keys(input).length > 0 ? { input } : {}),
              ...(overrides.version_override ? { version: overrides.version_override } : {}),
              ...(overrides.model_id_override ? { modelId: overrides.model_id_override } : {}),
              ...(proxy ? { proxyId: proxy === "__none__" ? "none" : proxy } : {}),
              ...(overrides.config_override ? { config: overrides.config_override } : {}),
              ...(overrides.connection_overrides
                ? { connectionOverrides: overrides.connection_overrides }
                : {}),
              ...(Object.keys(dependencyOverrides).length > 0 ? { dependencyOverrides } : {}),
            },
            { onSuccess: () => setRunOptionsOpen(false) },
          );
        }}
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
