import { useTranslation } from "react-i18next";
import { useFlowDetail } from "../../hooks/use-packages";
import { useExecutions } from "../../hooks/use-executions";
import { useFlowMemories } from "../../hooks/use-memories";
import {
  useDeleteFlow,
  useDeleteFlowExecutions,
  useDeleteAllMemories,
} from "../../hooks/use-mutations";
import { useFlowReadiness } from "../../hooks/use-flow-readiness";
import { useFlowDetailUI } from "../../stores/flow-detail-ui-store";
import { PackageActionsDropdown } from "./package-actions-dropdown";

export function FlowActions({
  packageId,
  isOrgAdmin,
  isHistoricalVersion,
  hasDraftChanges,
  downloadVersion,
  downloadPackage,
  onCreateVersion,
}: {
  packageId: string;
  isOrgAdmin: boolean;
  isHistoricalVersion: boolean;
  hasDraftChanges: boolean;
  downloadVersion: string | undefined;
  downloadPackage: (v: string) => void;
  onCreateVersion: () => void;
}) {
  const { t } = useTranslation(["flows", "common"]);
  const { data: detail } = useFlowDetail(packageId);
  const { data: executions } = useExecutions(packageId);
  const { data: memories } = useFlowMemories(packageId);
  const deleteFlow = useDeleteFlow();
  const deleteExecutions = useDeleteFlowExecutions(packageId);
  const deleteAllMemories = useDeleteAllMemories(packageId);
  const setConfigOpen = useFlowDetailUI((s) => s.setConfigOpen);
  const setScheduleOpen = useFlowDetailUI((s) => s.setScheduleOpen);
  const setEditingSchedule = useFlowDetailUI((s) => s.setEditingSchedule);
  const readiness = useFlowReadiness(detail);

  if (!detail) return null;

  const { hasConfigSchema } = readiness;

  const hasFileInput =
    detail.input?.schema?.properties &&
    Object.values(detail.input.schema.properties).some((p) => p.type === "file");

  return (
    <PackageActionsDropdown
      packageId={packageId}
      type="flow"
      isOrgAdmin={isOrgAdmin}
      isBuiltIn={detail.source === "system"}
      isHistoricalVersion={isHistoricalVersion}
      hasDraftChanges={hasDraftChanges}
      downloadVersion={downloadVersion}
      onDownload={downloadPackage}
      onCreateVersion={onCreateVersion}
      hasConfigSchema={hasConfigSchema}
      onConfigure={() => setConfigOpen(true)}
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
      shareServices={detail.requires.services}
    />
  );
}
