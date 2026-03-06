import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useFlowDetailContext } from "../../hooks/use-flow-detail-context";
import { ExecutionRow } from "../execution-row";
import { ScheduleRow } from "../schedule-row";
import { RunFlowButton } from "../run-flow-button";
import { EmptyState } from "../page-states";
import { formatDateField } from "../../lib/markdown";

export function FlowExecutionsTab({
  isOrgAdmin,
  resolvedVersion,
}: {
  isOrgAdmin: boolean;
  resolvedVersion: string | undefined;
}) {
  const { t } = useTranslation(["flows", "common"]);
  const ctx = useFlowDetailContext();
  const {
    detail,
    packageId,
    executions,
    profileMap,
    deleteExecutions,
    allConnected,
    hasReconnectionNeeded,
    hasRequiredConfig,
  } = ctx;

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

export function FlowSchedulesTab() {
  const { t } = useTranslation(["flows", "common"]);
  const ctx = useFlowDetailContext();
  const { detail, schedules, setEditingSchedule, setScheduleOpen } = ctx;

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

export function FlowMemoriesTab({ isOrgAdmin }: { isOrgAdmin: boolean }) {
  const { t } = useTranslation(["flows", "common"]);
  const ctx = useFlowDetailContext();
  const { memories, deleteMemory, deleteAllMemories } = ctx;

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
