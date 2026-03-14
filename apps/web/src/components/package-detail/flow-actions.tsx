import { useTranslation } from "react-i18next";
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

export function FlowActions({
  packageId,
  isOrgAdmin,
  isOwned,
  isHistoricalVersion,
  hasDraftChanges,
  downloadVersion,
  downloadPackage,
  onCreateVersion,
  onFork,
}: {
  packageId: string;
  isOrgAdmin: boolean;
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

  if (!detail) return null;

  const hasFileInput =
    detail.input?.schema?.properties &&
    Object.values(detail.input.schema.properties).some((p) => p.type === "file");

  return (
    <PackageActionsDropdown
      packageId={packageId}
      type="flow"
      isOrgAdmin={isOrgAdmin}
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
      onDeleteFlow={() => {
        if (confirm(t("detail.deleteConfirm", { name: detail.displayName }))) {
          deleteFlow.mutate(detail.id);
        }
      }}
      onDeleteExecutions={() => {
        if (confirm(t("detail.clearExecConfirm"))) {
          deleteExecutions.mutate();
        }
      }}
      onAddSchedule={() => {
        setEditingSchedule(null);
        setScheduleOpen(true);
      }}
      onDeleteMemories={() => {
        if (confirm(t("detail.clearMemoriesConfirm"))) {
          deleteAllMemories.mutate();
        }
      }}
      shareServices={detail.requires.providers}
    />
  );
}
