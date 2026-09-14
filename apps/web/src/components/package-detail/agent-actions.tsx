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
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { PackageActionsDropdown } from "./package-actions-dropdown";
import { ConfirmModal } from "../confirm-modal";
import { RunWithOptionsModal } from "../run-with-options-modal";

export function AgentActions({
  packageId,
  isOwned,
  isHistoricalVersion,
  downloadVersion,
  downloadPackage,
  downloadBundle,
  onCreateVersion,
  onFork,
}: {
  packageId: string;
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
  const installToggle = useTogglePackageInstall();
  const runAgent = useRunAgent(packageId);
  const currentSpaceId = useCurrentSpaceId();
  const { isInstalledInCurrentSpace } = usePackageInstallState(packageId);

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
        if (!currentSpaceId) return;
        installToggle.mutate(
          { spaceId: currentSpaceId, packageId, installed: true },
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
        isOwned={isOwned}
        isBuiltIn={detail.source === "system"}
        isHistoricalVersion={isHistoricalVersion}
        homeSpaceId={detail.home_space_id}
        homeWritable={detail.home_writable}
        homeShareable={detail.home_shareable}
        downloadVersion={downloadVersion}
        onDownload={downloadPackage}
        onDownloadBundle={downloadBundle}
        hasPublishedVersion={(detail.version_count ?? 0) > 0}
        isInstalledHere={isInstalledInCurrentSpace}
        onCreateVersion={onCreateVersion}
        onFork={onFork}
        runningRuns={detail.running_runs}
        hasRuns={!!runs && runs.length > 0}
        hasMemories={!!memories && memories.length > 0}
        hasFileInput={!!hasFileInput}
        onDeleteAgent={() =>
          setConfirmState({
            type: "deleteAgent",
            label: t("detail.deleteConfirm", { name: detail.display_name }),
          })
        }
        // The agents index lists what this space READS — an agent homed here or
        // offered here and activated nowhere is on it, and running it needs an
        // installation. This is the door: the same `POST
        // /api/spaces/{spaceId}/packages` the library and the offers section
        // call, reached from the page the index links to.
        canInstall={!isInstalledInCurrentSpace && detail.source !== "system"}
        onInstall={() => {
          if (!currentSpaceId) return;
          installToggle.mutate({ spaceId: currentSpaceId, packageId, installed: false });
        }}
        installPending={installToggle.isPending}
        canUninstall={isInstalledInCurrentSpace && detail.source !== "system"}
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
        // Nothing published and the working copy is not this caller's: the
        // launcher would open on a version that does not exist, and the
        // server would answer `404 no_published_version`.
        {...(detail.definition === "draft" && !detail.home_writable
          ? { runBlockedReason: t("detail.titleNeverPublished") }
          : {})}
      />
      <RunWithOptionsModal
        open={runOptionsOpen}
        onClose={() => setRunOptionsOpen(false)}
        agent={detail}
        isPending={runAgent.isPending}
        onSubmit={({ input, version, overrides, dependencyOverrides }) => {
          // Map the modal payload onto the run API body. `version` rides the
          // `?version=` query and is always an explicit pick here — the modal
          // seeds it with the same default plain "Lancer" would send. The
          // overrides panel already emits the server's wire values (a proxy
          // pick of "none" means no proxy), so the value passes through as-is.
          const proxy = overrides.proxy_id_override;
          runAgent.mutate(
            {
              ...(Object.keys(input).length > 0 ? { input } : {}),
              version,
              ...(overrides.model_id_override ? { modelId: overrides.model_id_override } : {}),
              ...(overrides.generation_config_override
                ? { generation: overrides.generation_config_override }
                : {}),
              ...(proxy ? { proxyId: proxy } : {}),
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
          installToggle.isPending
        }
      />
    </>
  );
}
