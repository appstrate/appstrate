import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useFlowDetail } from "../../hooks/use-packages";
import { useExecutions } from "../../hooks/use-executions";
import { useFlowMemories } from "../../hooks/use-memories";
import { useSchedules } from "../../hooks/use-schedules";
import {
  useDeleteFlowExecutions,
  useDeleteMemory,
  useDeleteAllMemories,
} from "../../hooks/use-mutations";
import { useProfiles } from "../../hooks/use-profiles";
import { useFlowReadiness } from "../../hooks/use-flow-readiness";
import { useFlowDetailUI } from "../../stores/flow-detail-ui-store";
import { ExecutionRow } from "../execution-row";
import { ScheduleRow } from "../schedule-row";
import { RunFlowButton } from "../run-flow-button";
import { EmptyState } from "../page-states";
import { formatDateField } from "../../lib/markdown";

export function FlowExecutionsTab({
  packageId,
  isOrgAdmin,
  resolvedVersion,
}: {
  packageId: string;
  isOrgAdmin: boolean;
  resolvedVersion: string | undefined;
}) {
  const { t } = useTranslation(["flows", "common"]);
  const { data: detail } = useFlowDetail(packageId);
  const { data: executions } = useExecutions(packageId);
  const deleteExecutions = useDeleteFlowExecutions(packageId);
  const profileMap = useProfiles(
    (executions ?? []).map((e) => e.userId).filter((id): id is string => !!id),
  );
  const readiness = useFlowReadiness(detail);

  if (!detail) return null;

  const { allConnected, hasReconnectionNeeded, hasRequiredConfig } = readiness;
  const runDisabled = !allConnected || hasReconnectionNeeded || !hasRequiredConfig;

  return (
    <>
      {isOrgAdmin && executions && executions.length > 0 && (
        <div className="flex items-center justify-between mb-4">
          <div />
          <Button
            variant="destructive"
            size="sm"
            disabled={detail.runningExecutions > 0 || deleteExecutions.isPending}
            title={
              detail.runningExecutions > 0 ? t("detail.clearExecRunning") : t("detail.clearExec")
            }
            onClick={() => {
              if (confirm(t("detail.clearExecConfirm"))) {
                deleteExecutions.mutate();
              }
            }}
          >
            {t("detail.clearExec")}
          </Button>
        </div>
      )}
      {!executions || executions.length === 0 ? (
        <EmptyState message={t("detail.emptyExec")} compact>
          <RunFlowButton
            packageId={packageId}
            detail={detail}
            version={resolvedVersion}
            disabled={runDisabled}
            showLabel
          />
        </EmptyState>
      ) : (
        <div className="space-y-1">
          {executions.map((exec, index) => (
            <ExecutionRow
              key={exec.id}
              execution={exec}
              executionNumber={executions.length - index}
              userName={exec.userId ? profileMap.get(exec.userId) : undefined}
            />
          ))}
        </div>
      )}
    </>
  );
}

export function FlowSchedulesTab({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["flows", "common"]);
  const { data: detail } = useFlowDetail(packageId);
  const { data: schedules } = useSchedules(packageId);
  const setEditingSchedule = useFlowDetailUI((s) => s.setEditingSchedule);
  const setScheduleOpen = useFlowDetailUI((s) => s.setScheduleOpen);

  if (!detail) return null;

  const hasFileInput =
    detail.input?.schema?.properties &&
    Object.values(detail.input.schema.properties).some((p) => p.type === "file");

  if (hasFileInput) {
    return <EmptyState message={t("schedule.fileInputBlocked")} compact />;
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div />
        <Button
          variant="outline"
          onClick={() => {
            setEditingSchedule(null);
            setScheduleOpen(true);
          }}
        >
          {t("btn.add")}
        </Button>
      </div>
      {!schedules || schedules.length === 0 ? (
        <EmptyState message={t("detail.emptySchedule")} compact>
          <Button
            onClick={() => {
              setEditingSchedule(null);
              setScheduleOpen(true);
            }}
          >
            {t("btn.add")}
          </Button>
        </EmptyState>
      ) : (
        <div className="space-y-1">
          {schedules.map((sched) => (
            <ScheduleRow
              key={sched.id}
              schedule={sched}
              onClick={() => {
                setEditingSchedule(sched);
                setScheduleOpen(true);
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}

export function FlowMemoriesTab({
  packageId,
  isOrgAdmin,
}: {
  packageId: string;
  isOrgAdmin: boolean;
}) {
  const { t } = useTranslation(["flows", "common"]);
  const { data: memories } = useFlowMemories(packageId);
  const deleteMemory = useDeleteMemory(packageId);
  const deleteAllMemories = useDeleteAllMemories(packageId);

  return (
    <>
      {isOrgAdmin && memories && memories.length > 0 && (
        <div className="flex items-center justify-between mb-4">
          <div />
          <Button
            variant="destructive"
            size="sm"
            disabled={deleteAllMemories.isPending}
            onClick={() => {
              if (confirm(t("detail.clearMemoriesConfirm"))) {
                deleteAllMemories.mutate();
              }
            }}
          >
            {t("detail.clearMemories")}
          </Button>
        </div>
      )}
      {!memories || memories.length === 0 ? (
        <EmptyState
          message={t("detail.emptyMemories")}
          hint={t("detail.emptyMemoriesHint")}
          compact
        />
      ) : (
        <div className="space-y-1">
          {memories.map((mem) => (
            <div
              key={mem.id}
              className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
            >
              <span className="flex-1 text-sm text-foreground truncate">{mem.content}</span>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {mem.createdAt ? formatDateField(mem.createdAt) : ""}
              </span>
              {isOrgAdmin && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => deleteMemory.mutate(mem.id)}
                  disabled={deleteMemory.isPending}
                >
                  {t("btn.delete")}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
