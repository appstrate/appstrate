import { useState, useCallback, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useFlowDetail } from "../hooks/use-flows";
import { useExecution, useExecutionLogs } from "../hooks/use-executions";
import { useRunFlow } from "../hooks/use-mutations";
import { useExecutionRealtime } from "../hooks/use-realtime";
import { Spinner } from "../components/spinner";
import { Badge } from "../components/badge";
import { LogViewer, type LogEntry } from "../components/log-viewer";
import { ResultRenderer } from "../components/result-renderer";
import { InputModal } from "../components/input-modal";
import type { ExecutionStatus } from "@appstrate/shared-types";
import { formatDateField } from "../lib/markdown";

function formatEvent(event: string, data: Record<string, unknown>): string {
  if (event === "execution_started") return `Execution demarree (${data?.executionId || ""})`;
  if (event === "dependency_check") {
    const checks = Object.entries((data?.services as Record<string, string>) || {})
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    return `Dependances verifiees — ${checks}`;
  }
  if (event === "adapter_started") return `Adapter ${data?.adapter || "unknown"} demarre`;
  return "";
}

export function ExecutionDetailPage() {
  const { flowId, execId } = useParams<{ flowId: string; execId: string }>();
  const { data: flow } = useFlowDetail(flowId);
  const { data: execution, isLoading, error } = useExecution(execId);
  const { data: logs } = useExecutionLogs(execId);

  const runFlow = useRunFlow(flowId!);
  const [inputOpen, setInputOpen] = useState(false);
  const [userTab, setUserTab] = useState<"logs" | "result" | null>(null);
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>([]);
  const [liveResult, setLiveResult] = useState<Record<string, unknown> | null>(null);
  const [liveStatus, setLiveStatus] = useState<ExecutionStatus | null>(null);

  const status = liveStatus || execution?.status;
  const isRunning = status === "running" || status === "pending";

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
            (logData.message as string) || log.message || formatEvent(log.event || "", logData);
          if (message) entries.push({ message, type: log.type || "progress" });
        }
      }
    }

    return { historicalLogs: entries, historicalResult: result };
  }, [logs]);

  // If execution is finished, use result from logs or execution object
  const resultData =
    liveResult || historicalResult || (execution?.result as Record<string, unknown> | null);
  const allLogs = useMemo(
    () => (isRunning ? [...historicalLogs, ...liveLogs] : historicalLogs),
    [isRunning, historicalLogs, liveLogs],
  );

  // Derive active tab: user override > auto-switch to result when done
  const activeTab = userTab ?? (resultData && !isRunning ? "result" : "logs");

  const qc = useQueryClient();

  // Subscribe to Supabase Realtime for live logs and status changes
  useExecutionRealtime(isRunning ? execId : null, {
    onLog: useCallback((payload: Record<string, unknown>) => {
      const event = payload.event as string;
      const data = payload.data as Record<string, unknown> | null;
      const message = payload.message as string | null;

      if (event === "result" && data) {
        setLiveResult(data);
        setUserTab((prev) => (prev === null ? "result" : prev));
      } else if (event === "execution_completed") {
        // Status change is handled via onStatusChange
      } else if (event === "progress") {
        setLiveLogs((prev) => [...prev, { message: message || "", type: "progress" }]);
      } else {
        const text = message || formatEvent(event, data || {});
        if (text) setLiveLogs((prev) => [...prev, { message: text, type: "system" }]);
      }
    }, []),
    onStatusChange: useCallback(
      (payload: Record<string, unknown>) => {
        const newStatus = payload.status as ExecutionStatus;
        setLiveStatus(newStatus);
        if (payload.result) {
          setLiveResult(payload.result as Record<string, unknown>);
        }
        // Refresh execution and logs queries when status changes
        qc.invalidateQueries({ queryKey: ["execution", execId] });
        qc.invalidateQueries({ queryKey: ["execution-logs", execId] });
      },
      [qc, execId],
    ),
  });

  if (isLoading) {
    return (
      <div className="empty-state">
        <Spinner />
      </div>
    );
  }

  if (error || !execution) {
    return (
      <div className="empty-state">
        <p>Impossible de charger l'execution.</p>
        <p className="empty-hint">{error?.message}</p>
      </div>
    );
  }

  const displayStatus = status || execution.status;
  const date = execution.started_at ? formatDateField(execution.started_at) : "";
  const duration = execution.duration ? `${(execution.duration / 1000).toFixed(1)}s` : "";

  return (
    <>
      <nav className="breadcrumb">
        <Link to="/">Flows</Link>
        <span className="separator">/</span>
        <Link to={`/flows/${flowId}`}>{flow?.displayName || flowId}</Link>
        <span className="separator">/</span>
        <span className="current">{execId?.slice(0, 16)}...</span>
      </nav>

      <div className="exec-detail-header">
        <Badge status={displayStatus} />
        <span className="exec-meta">{date}</span>
        {duration && <span className="exec-meta">{duration}</span>}
        {isRunning && (
          <span className="live-indicator">
            <Spinner /> En direct
          </span>
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
            Relancer
          </button>
        )}
      </div>

      {flow && (
        <InputModal
          open={inputOpen}
          onClose={() => setInputOpen(false)}
          flow={flow}
          onSubmit={(input) => runFlow.mutate(input)}
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
          Logs <span>{allLogs.length} events</span>
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "result"}
          className={`tab ${activeTab === "result" ? "active" : ""}`}
          onClick={() => setUserTab("result")}
        >
          Resultat
        </button>
      </div>

      {activeTab === "logs" && <LogViewer entries={allLogs} />}

      {activeTab === "result" &&
        (resultData ? (
          <ResultRenderer data={resultData} outputSchema={flow?.output?.schema} />
        ) : (
          <div className="empty-state empty-state-compact">
            <p className="empty-hint">Aucun resultat</p>
          </div>
        ))}
    </>
  );
}
