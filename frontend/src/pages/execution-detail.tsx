import { useState, useCallback, useEffect, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { useFlowDetail } from "../hooks/use-flows";
import { useExecution, useExecutionLogs } from "../hooks/use-executions";
import { useWsChannel } from "../hooks/use-websocket";
import { Spinner } from "../components/spinner";
import { Badge } from "../components/badge";
import { LogViewer, type LogEntry } from "../components/log-viewer";
import { ResultRenderer } from "../components/result-renderer";
import type { ExecutionStatus } from "../types";

function formatEvent(event: string, data: Record<string, unknown>): string {
  if (event === "execution_started") return `Execution demarree (${data?.executionId || ""})`;
  if (event === "dependency_check") {
    const checks = Object.entries((data?.services as Record<string, string>) || {}).map(([k, v]) => `${k}: ${v}`).join(", ");
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

  const [activeTab, setActiveTab] = useState<"logs" | "result">("logs");
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
          result = log.data;
        } else if (log.event === "execution_completed") {
          // skip
        } else {
          const message = (log.data as Record<string, string>)?.message || log.message || formatEvent(log.event || "", log.data || {});
          if (message) entries.push({ message, type: log.type || "progress" });
        }
      }
    }

    return { historicalLogs: entries, historicalResult: result };
  }, [logs]);

  // If execution is finished, use result from logs or execution object
  const resultData = liveResult || historicalResult || (execution?.result as Record<string, unknown> | null);
  const allLogs = useMemo(
    () => isRunning ? [...historicalLogs, ...liveLogs] : historicalLogs,
    [isRunning, historicalLogs, liveLogs]
  );

  // Switch to result tab when result arrives
  useEffect(() => {
    if (resultData && !isRunning) {
      setActiveTab("result");
    }
  }, [resultData, isRunning]);

  // Live WS handler
  const handleWsMessage = useCallback((msg: Record<string, unknown>) => {
    const event = msg.event as string;
    const data = (msg.data || {}) as Record<string, unknown>;

    if (event === "result" && data) {
      setLiveResult(data);
      setActiveTab("result");
    } else if (event === "execution_completed") {
      setLiveStatus((data.status as ExecutionStatus) || "failed");
    } else if (event === "progress") {
      setLiveLogs((prev) => [...prev, { message: (data.message as string) || "", type: "progress" }]);
    } else {
      const message = (data.message as string) || formatEvent(event, data);
      if (message) setLiveLogs((prev) => [...prev, { message, type: "system" }]);
    }
  }, []);

  useWsChannel(isRunning ? `execution:${execId}` : null, handleWsMessage);

  if (isLoading) {
    return <div className="empty-state"><Spinner /></div>;
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
  const date = new Date(execution.started_at).toLocaleString("fr-FR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
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
          <span className="live-indicator"><Spinner /> En direct</span>
        )}
      </div>

      <div className="exec-tabs">
        <button
          className={`tab ${activeTab === "logs" ? "active" : ""}`}
          onClick={() => setActiveTab("logs")}
        >
          Logs <span>{allLogs.length} events</span>
        </button>
        <button
          className={`tab ${activeTab === "result" ? "active" : ""}`}
          onClick={() => setActiveTab("result")}
        >
          Resultat
        </button>
      </div>

      {activeTab === "logs" && <LogViewer entries={allLogs} />}

      {activeTab === "result" && (
        resultData ? (
          <ResultRenderer data={resultData} />
        ) : (
          <div className="empty-state empty-state-compact">
            <p className="empty-hint">Aucun resultat</p>
          </div>
        )
      )}
    </>
  );
}
