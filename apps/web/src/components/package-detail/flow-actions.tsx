// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isFileField } from "@appstrate/core/form";
import { usePackageDetail } from "../../hooks/use-packages";
import { useExecutions } from "../../hooks/use-executions";
import { useFlowMemories } from "../../hooks/use-memories";
import {
  useDeleteFlow,
  useDeleteFlowExecutions,
  useDeleteAllMemories,
} from "../../hooks/use-mutations";
import { useFlowDetailUI } from "../../stores/flow-detail-ui-store";
import { PackageActionsDropdown } from "./package-actions-dropdown";
import { ConfirmModal } from "../confirm-modal";

export function FlowActions({
  packageId,
  manifest,
  isOwned,
  isHistoricalVersion,
  hasDraftChanges,
  downloadVersion,
  downloadPackage,
  onCreateVersion,
  onFork,
}: {
  packageId: string;
  manifest?: Record<string, unknown>;
  isOwned: boolean;
  isHistoricalVersion: boolean;
  hasDraftChanges: boolean;
  downloadVersion: string | undefined;
  downloadPackage: (v: string) => void;
  onCreateVersion: () => void;
  onFork?: () => void;
}) {
  const { t } = useTranslation(["flows", "common"]);
  const { data: detail } = usePackageDetail("flow", packageId);
  const { data: executions } = useExecutions(packageId);
  const { data: memories } = useFlowMemories(packageId);
  const deleteFlow = useDeleteFlow();
  const deleteExecutions = useDeleteFlowExecutions(packageId);
  const deleteAllMemories = useDeleteAllMemories(packageId);
  const setScheduleOpen = useFlowDetailUI((s) => s.setScheduleOpen);
  const setEditingSchedule = useFlowDetailUI((s) => s.setEditingSchedule);

  const [confirmState, setConfirmState] = useState<{
    type: "deleteFlow" | "clearExecutions" | "clearMemories";
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
      case "deleteFlow":
        deleteFlow.mutate(detail.id, { onSuccess });
        break;
      case "clearExecutions":
        deleteExecutions.mutate(undefined, { onSuccess });
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
        type="flow"
        manifest={manifest}
        isOwned={isOwned}
        isBuiltIn={detail.source === "system"}
        isHistoricalVersion={isHistoricalVersion}
        hasDraftChanges={hasDraftChanges}
        downloadVersion={downloadVersion}
        onDownload={downloadPackage}
        onCreateVersion={onCreateVersion}
        onFork={onFork}
        runningExecutions={detail.runningExecutions}
        hasExecutions={!!executions && executions.length > 0}
        hasMemories={!!memories && memories.length > 0}
        hasFileInput={!!hasFileInput}
        onDeleteFlow={() =>
          setConfirmState({
            type: "deleteFlow",
            label: t("detail.deleteConfirm", { name: detail.displayName }),
          })
        }
        onDeleteExecutions={() =>
          setConfirmState({
            type: "clearExecutions",
            label: t("detail.clearExecConfirm"),
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
        isPending={
          deleteFlow.isPending || deleteExecutions.isPending || deleteAllMemories.isPending
        }
      />
    </>
  );
}
