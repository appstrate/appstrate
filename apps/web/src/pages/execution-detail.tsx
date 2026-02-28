import { useState, useCallback, useMemo, useEffect } from "react";
import { useParams, Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useFlowDetail } from "../hooks/use-flows";
import { useExecution, useExecutionLogs } from "../hooks/use-executions";
import { useRunFlow, useCancelExecution } from "../hooks/use-mutations";
import { Spinner } from "../components/spinner";
import { useExecutionRealtime, useExecutionLogsRealtime } from "../hooks/use-realtime";
import { useCurrentOrgId } from "../hooks/use-org";
import { Badge } from "../components/badge";
import { LogViewer, type LogEntry } from "../components/log-viewer";
import { ResultRenderer } from "../components/result-renderer";
import { InputModal } from "../components/input-modal";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { useProfiles } from "../hooks/use-profiles";
import { useMarkRead } from "../hooks/use-notifications";
import type { ExecutionStatus, ExecutionLog } from "@appstrate/shared-types";
import { formatDateField } from "../lib/markdown";

function formatToolArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const str = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(`${key}: ${str}`);
  }
  const joined = parts.join(", ");
  return joined.length > 200 ? joined.slice(0, 200) + "..." : joined;
}

export function ExecutionDetailPage() {
  const { t } = useTranslation(["flows", "common"]);
  const { flowId, execId } = useParams<{ flowId: string; execId: string }>();
  const location = useLocation();
  const executionNumber = (location.state as { executionNumber?: number } | null)?.executionNumber;
  const orgId = useCurrentOrgId();
  const { data: flow } = useFlowDetail(flowId);
  const { data: execution, isLoading, error } = useExecution(execId);
  const profileMap = useProfiles(execution?.userId ? [execution.userId] : []);
  const [liveStatus, setLiveStatus] = useState<ExecutionStatus | null>(null);
  const [trackedExecId, setTrackedExecId] = useState(execId);

  // Reset live status when switching to a different execution (e.g. re-run navigates
  // to a new execId on the same route, so React reuses the component instance).
  // Using the "state derived from props" pattern (setState during render) avoids
  // the cascading-render lint warning from calling setState inside useEffect.
  if (execId !== trackedExecId) {
    setTrackedExecId(execId);
    setLiveStatus(null);
  }

  const status = liveStatus || execution?.status;
  const isRunning = status === "running" || status === "pending";

  const { data: logs } = useExecutionLogs(execId);

  const qc = useQueryClient();

  // Subscribe to new log INSERTs via SSE while execution is running
  useExecutionLogsRealtime(
    isRunning ? execId : null,
    useCallback(
      (newLog: Record<string, unknown>) => {
        const log = newLog as unknown as ExecutionLog;
        qc.setQueryData<ExecutionLog[]>(["execution-logs", orgId, execId], (prev) => {
          if (!prev) return [log];
          // Deduplicate: skip if already present (race between REST fetch and SSE)
          if (prev.some((l) => l.id === log.id)) return prev;
          return [...prev, log];
        });
      },
      [qc, orgId, execId],
    ),
  );

  const markRead = useMarkRead();

  // Auto-mark notification as read when viewing an execution
  useEffect(() => {
    if (execution && execId && execution.notifiedAt && !execution.readAt) {
      markRead.mutate(execId);
    }
  }, [execution?.notifiedAt, execution?.readAt, execId]); // eslint-disable-line react-hooks/exhaustive-deps

  const runFlow = useRunFlow(flowId!);
  const cancelExecution = useCancelExecution();
  const [inputOpen, setInputOpen] = useState(false);
  const [userTab, setUserTab] = useState<"logs" | "result" | "state" | null>(null);

  // Build log entries from historical data, merging consecutive text-only
  // progress entries into a single flowing block so small streaming fragments
  // don't each render on their own line.
  const { historicalLogs, historicalResult } = useMemo(() => {
    const entries: LogEntry[] = [];
    let result: Record<string, unknown> | null = null;
    let lastWasPlainText = false;

    if (logs) {
      for (const log of logs) {
        if (log.event === "result" && log.data) {
          result = log.data as Record<string, unknown>;
          lastWasPlainText = false;
        } else if (log.event === "execution_completed") {
          lastWasPlainText = false;
        } else {
          const logData = (log.data ?? {}) as Record<string, unknown>;
          const message = (logData.message as string) || log.message || "";
          if (message) {
            const args = logData.args as Record<string, unknown> | undefined;
            const detail = args ? formatToolArgs(args) : undefined;
            // Text-only progress: no structured data (tool calls have data.tool/data.args)
            const isPlainText = log.type === "progress" && !log.data;

            if (isPlainText && lastWasPlainText && entries.length > 0) {
              // Merge into previous text entry with newline to preserve natural breaks
              entries[entries.length - 1]!.message += "\n" + message;
            } else {
              entries.push({ message, type: log.type || "progress", detail });
            }
            lastWasPlainText = isPlainText;
          }
        }
      }
    }

    return { historicalLogs: entries, historicalResult: result };
  }, [logs]);

  // Use result from logs or execution object
  const resultData = historicalResult || (execution?.result as Record<string, unknown> | null);
  const stateData = (execution?.state as Record<string, unknown> | null) ?? null;
  const allLogs = historicalLogs;

  // Derive active tab: user override > auto-switch to result when done
  const activeTab = userTab ?? (resultData && !isRunning ? "result" : "logs");

  // Live elapsed timer while running
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isRunning || !execution?.startedAt) return;
    const start = new Date(execution.startedAt).getTime();
    const tick = () => setElapsed(Date.now() - start);
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [isRunning, execution?.startedAt]);

  // Subscribe to SSE for instant local status feedback
  useExecutionRealtime(
    isRunning ? execId : null,
    useCallback(
      (payload: Record<string, unknown>) => {
        const newStatus = payload.status as ExecutionStatus;
        setLiveStatus(newStatus);
        // Safety net: final refetch of logs on terminal status (ensures completeness)
        const terminal =
          newStatus === "success" ||
          newStatus === "failed" ||
          newStatus === "timeout" ||
          newStatus === "cancelled";
        if (terminal) {
          qc.invalidateQueries({ queryKey: ["execution", orgId, execId] });
          qc.invalidateQueries({ queryKey: ["execution-logs", orgId, execId] });
        }
      },
      [qc, orgId, execId],
    ),
  );

  if (isLoading) return <LoadingState />;

  if (error || !execution) return <ErrorState message={error?.message} />;

  const displayStatus = status || execution.status;
  const date = execution.startedAt ? formatDateField(execution.startedAt) : "";
  const time = execution.duration ?? elapsed;
  const duration = time ? `${(time / 1000).toFixed(1)}s` : "";
  const userName = execution.userId ? profileMap.get(execution.userId) : undefined;

  return (
    <>
      <nav className="breadcrumb">
        <Link to="/">{t("detail.breadcrumb")}</Link>
        <span className="separator">/</span>
        <Link to={`/flows/${flowId}`}>{flow?.displayName || flowId}</Link>
        <span className="separator">/</span>
        <span className="current">
          {executionNumber
            ? t("exec.breadcrumb", { number: executionNumber })
            : date || execId?.slice(0, 8)}
        </span>
      </nav>

      <div className="exec-detail-header">
        <Badge status={displayStatus} />
        {userName && <span className="exec-user">{t("exec.user", { name: userName })}</span>}
        <span className="exec-meta">{date}</span>
        {duration && <span className="exec-meta">{duration}</span>}
        {!isRunning && execution.tokensUsed != null && (
          <span className="exec-meta">{execution.tokensUsed.toLocaleString()} tokens</span>
        )}
        {isRunning && (
          <button
            className="danger"
            onClick={() => cancelExecution.mutate(execId!)}
            disabled={cancelExecution.isPending}
          >
            {cancelExecution.isPending && <Spinner />} {t("btn.cancel")}
          </button>
        )}
        {!isRunning && flow && (
          <button
            className="primary"
            onClick={() => {
              const hasInput = flow.input?.schema && Object.keys(flow.input.schema).length > 0;
              if (hasInput) {
                setInputOpen(true);
              } else {
                runFlow.mutate(undefined);
              }
            }}
            disabled={runFlow.isPending}
          >
            {t("exec.rerun")}
          </button>
        )}
      </div>

      {flow && (
        <InputModal
          open={inputOpen}
          onClose={() => setInputOpen(false)}
          flow={flow}
          onSubmit={(input, files) => {
            runFlow.mutate({ input, files }, { onSuccess: () => setInputOpen(false) });
          }}
          isPending={runFlow.isPending}
          initialValues={(execution.input as Record<string, unknown>) ?? undefined}
        />
      )}

      <div className="exec-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={activeTab === "logs"}
          className={`tab ${activeTab === "logs" ? "active" : ""}`}
          onClick={() => setUserTab("logs")}
        >
          {t("exec.tabLogs")} <span>{t("exec.tabLogEvents", { count: allLogs.length })}</span>
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "result"}
          className={`tab ${activeTab === "result" ? "active" : ""}`}
          onClick={() => setUserTab("result")}
        >
          {t("exec.tabResult")}
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "state"}
          className={`tab ${activeTab === "state" ? "active" : ""}`}
          onClick={() => setUserTab("state")}
        >
          {t("exec.tabState")}
        </button>
      </div>

      {displayStatus === "failed" && execution.error && (
        <div className="exec-error">{execution.error}</div>
      )}

      {activeTab === "logs" && <LogViewer entries={allLogs} />}

      {activeTab === "result" &&
        (resultData ? (
          <ResultRenderer data={resultData} outputSchema={flow?.output?.schema} />
        ) : (
          <EmptyState message={t("exec.emptyResult")} compact />
        ))}

      {activeTab === "state" &&
        (stateData ? (
          <pre className="result-json-viewer">{JSON.stringify(stateData, null, 2)}</pre>
        ) : (
          <EmptyState message={t("exec.emptyState")} compact />
        ))}
    </>
  );
}
