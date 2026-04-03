// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isFileField } from "@appstrate/core/form";
import { usePackageDetail } from "../../hooks/use-packages";
import { useRuns } from "../../hooks/use-runs";
import { useAgentMemories } from "../../hooks/use-memories";
import {
  useDeleteAgent,
  useDeleteAgentRuns,
  useDeleteAllMemories,
} from "../../hooks/use-mutations";
import { useAgentDetailUI } from "../../stores/agent-detail-ui-store";
import { PackageActionsDropdown } from "./package-actions-dropdown";
import { ConfirmModal } from "../confirm-modal";

export function AgentActions({
  packageId,
  manifest,
  isOwned,
  isImported,
  isHistoricalVersion,
  downloadVersion,
  downloadPackage,
  onCreateVersion,
  onFork,
}: {
  packageId: string;
  manifest?: Record<string, unknown>;
  isOwned: boolean;
  isImported?: boolean;
  isHistoricalVersion: boolean;
  downloadVersion: string | undefined;
  downloadPackage: (v: string) => void;
  onCreateVersion: () => void;
  onFork?: () => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const { data: detail } = usePackageDetail("agent", packageId);
  const { data: runs } = useRuns(packageId);
  const { data: memories } = useAgentMemories(packageId);
  const deleteAgent = useDeleteAgent();
  const deleteRuns = useDeleteAgentRuns(packageId);
  const deleteAllMemories = useDeleteAllMemories(packageId);
  const setScheduleOpen = useAgentDetailUI((s) => s.setScheduleOpen);
  const setEditingSchedule = useAgentDetailUI((s) => s.setEditingSchedule);

  const [confirmState, setConfirmState] = useState<{
    type: "deleteAgent" | "clearRuns" | "clearMemories";
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
    }
  };

  return (
    <>
      <PackageActionsDropdown
        packageId={packageId}
        type="agent"
        manifest={manifest}
        isOwned={isOwned}
        isImported={isImported}
        isBuiltIn={detail.source === "system"}
        isHistoricalVersion={isHistoricalVersion}
        downloadVersion={downloadVersion}
        onDownload={downloadPackage}
        onCreateVersion={onCreateVersion}
        onFork={onFork}
        runningRuns={detail.runningRuns}
        hasRuns={!!runs && runs.length > 0}
        hasMemories={!!memories && memories.length > 0}
        hasFileInput={!!hasFileInput}
        onDeleteAgent={() =>
          setConfirmState({
            type: "deleteAgent",
            label: t("detail.deleteConfirm", { name: detail.displayName }),
          })
        }
        onDeleteRuns={() =>
          setConfirmState({
            type: "clearRuns",
            label: t("detail.clearRunsConfirm"),
          })
        }
        onAddSchedule={() => {
          setEditingSchedule(null);
          setScheduleOpen(true);
        }}
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
        isPending={deleteAgent.isPending || deleteRuns.isPending || deleteAllMemories.isPending}
      />
    </>
  );
}
