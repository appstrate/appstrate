import { useTranslation } from "react-i18next";
import { useFlowDetailContext } from "../../contexts/flow-detail-context";
import { ExecutionRow } from "../execution-row";
import { ScheduleRow } from "../schedule-row";
import { Spinner } from "../spinner";
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
    executions,
    profileMap,
    runFlow,
    deleteExecutions,
    allConnected,
    hasReconnectionNeeded,
    hasRequiredConfig,
    hasInputSchema,
    setInputOpen,
    profileId,
  } = ctx;

  const handleRun = () => {
    if (hasInputSchema) {
      setInputOpen(true);
    } else {
      runFlow.mutate({
        profileId: profileId ?? undefined,
        version: resolvedVersion,
      });
    }
  };

  return (
    <>
      {isOrgAdmin && executions && executions.length > 0 && (
        <div className="section-header">
          <div />
          <button
            className="btn-danger"
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
          </button>
        </div>
      )}
      {!executions || executions.length === 0 ? (
        <EmptyState message={t("detail.emptyExec")} compact>
          <button
            className="primary"
            onClick={handleRun}
            disabled={
              !allConnected || hasReconnectionNeeded || !hasRequiredConfig || runFlow.isPending
            }
          >
            {runFlow.isPending && <Spinner />} {t("detail.run")}
          </button>
        </EmptyState>
      ) : (
        <div className="exec-list">
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
      <div className="section-header">
        <div />
        <button
          onClick={() => {
            setEditingSchedule(null);
            setScheduleOpen(true);
          }}
        >
          {t("btn.add")}
        </button>
      </div>
      {!schedules || schedules.length === 0 ? (
        <EmptyState message={t("detail.emptySchedule")} compact>
          <button
            onClick={() => {
              setEditingSchedule(null);
              setScheduleOpen(true);
            }}
          >
            {t("btn.add")}
          </button>
        </EmptyState>
      ) : (
        <div className="schedule-list">
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
        <div className="section-header">
          <div />
          <button
            className="btn-danger"
            disabled={deleteAllMemories.isPending}
            onClick={() => {
              if (confirm(t("detail.clearMemoriesConfirm"))) {
                deleteAllMemories.mutate();
              }
            }}
          >
            {t("detail.clearMemories")}
          </button>
        </div>
      )}
      {!memories || memories.length === 0 ? (
        <EmptyState
          message={t("detail.emptyMemories")}
          hint={t("detail.emptyMemoriesHint")}
          compact
        />
      ) : (
        <div className="memory-list">
          {memories.map((mem) => (
            <div key={mem.id} className="memory-row">
              <span className="memory-content">{mem.content}</span>
              <span className="memory-date">
                {mem.createdAt ? formatDateField(mem.createdAt) : ""}
              </span>
              {isOrgAdmin && (
                <button
                  type="button"
                  className="btn-unbind"
                  onClick={() => deleteMemory.mutate(mem.id)}
                  disabled={deleteMemory.isPending}
                >
                  {t("btn.delete")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
