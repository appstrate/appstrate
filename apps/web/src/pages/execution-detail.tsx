import { useState, useCallback, useMemo, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
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
import type { ExecutionStatus, ExecutionLog } from "@appstrate/shared-types";
import { formatDateField } from "../lib/markdown";
import type { TFunction } from "i18next";

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

function formatEvent(event: string, data: Record<string, unknown>, t: TFunction): string {
  if (event === "execution_started") return t("exec.started", { id: data?.executionId || "" });
  if (event === "dependency_check") {
    const checks = Object.entries((data?.services as Record<string, string>) || {})
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    return t("exec.depsChecked", { checks });
  }
  if (event === "adapter_started") return t("exec.adapterStarted", { adapter: data?.adapter || "unknown" });
  return "";
}

export function ExecutionDetailPage() {
  const { t } = useTranslation(["flows", "common"]);
  const { flowId, execId } = useParams<{ flowId: string; execId: string }>();
  const orgId = useCurrentOrgId();
  const { data: flow } = useFlowDetail(flowId);
  const { data: execution, isLoading, error } = useExecution(execId);
  const profileMap = useProfiles(execution?.user_id ? [execution.user_id] : []);
  const [liveStatus, setLiveStatus] = useState<ExecutionStatus | null>(null);

  const status = liveStatus || execution?.status;
  const isRunning = status === "running" || status === "pending";

  const { data: logs } = useExecutionLogs(execId);

  const qc = useQueryClient();

  // Subscribe to new log INSERTs via Supabase Realtime while execution is running
  useExecutionLogsRealtime(
    isRunning ? execId : null,
    useCallback(
      (newLog: ExecutionLog) => {
        qc.setQueryData<ExecutionLog[]>(["execution-logs", orgId, execId], (prev) => {
          if (!prev) return [newLog];
          // Deduplicate: skip if already present (race between REST fetch and Realtime)
          if (prev.some((l) => l.id === newLog.id)) return prev;
          return [...prev, newLog];
        });
      },
      [qc, orgId, execId],
    ),
  );

  const runFlow = useRunFlow(flowId!);
  const cancelExecution = useCancelExecution();
  const [inputOpen, setInputOpen] = useState(false);
  const [userTab, setUserTab] = useState<"logs" | "result" | null>(null);

  // Build log entries from historical data
  const { historicalLogs, historicalResult } = useMemo(() => {
    const entries: LogEntry[] = [];
    let result: Record<string, unknown> | null = null;

    if (logs) {
      for (const log of logs) {
        if (log.event === "result" && log.data) {
          result = log.data as Record<string, unknown>;
        } else if (log.event === "execution_completed") {
          // skip
        } else {
          const logData = (log.data ?? {}) as Record<string, unknown>;
          const message =
            (logData.message as string) || log.message || formatEvent(log.event || "", logData, t);
          if (message) {
            const args = logData.args as Record<string, unknown> | undefined;
            const detail = args ? formatToolArgs(args) : undefined;
            entries.push({ message, type: log.type || "progress", detail });
          }
        }
      }
    }

    return { historicalLogs: entries, historicalResult: result };
  }, [logs, t]);

  // Use result from logs or execution object
  const resultData = historicalResult || (execution?.result as Record<string, unknown> | null);
  const allLogs = historicalLogs;

  // Derive active tab: user override > auto-switch to result when done
  const activeTab = userTab ?? (resultData && !isRunning ? "result" : "logs");

  // Live elapsed timer while running
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isRunning || !execution?.started_at) return;
    const start = new Date(execution.started_at).getTime();
    const tick = () => setElapsed(Date.now() - start);
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [isRunning, execution?.started_at]);

  // Subscribe to Supabase Realtime for instant local status feedback
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
          qc.invalidateQueries({ queryKey: ["execution-logs", orgId, execId] });
        }
      },
      [qc, orgId, execId],
    ),
  );

  if (isLoading) return <LoadingState />;

  if (error || !execution) return <ErrorState message={error?.message} />;

  const displayStatus = status || execution.status;
  const date = execution.started_at ? formatDateField(execution.started_at) : "";
  const time = execution.duration ?? elapsed;
  const duration = isRunning ? `${(time / 1000).toFixed(1)}s` : "";
  const userName = execution.user_id ? profileMap.get(execution.user_id) : undefined;

  return (
    <>
      <nav className="breadcrumb">
        <Link to="/">{t("detail.breadcrumb")}</Link>
        <span className="separator">/</span>
        <Link to={`/flows/${flowId}`}>{flow?.displayName || flowId}</Link>
        <span className="separator">/</span>
        <span className="current">{execId?.slice(0, 16)}...</span>
      </nav>

      <div className="exec-detail-header">
        <Badge status={displayStatus} />
        {userName && <span className="exec-user">{t("exec.user", { name: userName })}</span>}
        <span className="exec-meta">{date}</span>
        {duration && <span className="exec-meta">{duration}</span>}
        {!isRunning && execution.tokens_used != null && (
          <span className="exec-meta">{execution.tokens_used.toLocaleString()} tokens</span>
        )}
        {!isRunning && (execution as Record<string, unknown>).cost_usd != null && (
          <span className="exec-meta">
            ${Number((execution as Record<string, unknown>).cost_usd).toFixed(4)}
          </span>
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
    </>
  );
}
