import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useParams, Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { usePackageDetail } from "../hooks/use-packages";
import { useExecution, useExecutionLogs } from "../hooks/use-executions";
import { useRunFlow, useCancelExecution } from "../hooks/use-mutations";
import { Spinner } from "../components/spinner";
import { useExecutionRealtime, useExecutionLogsRealtime } from "../hooks/use-realtime";
import { useCurrentOrgId } from "../hooks/use-org";
import { Database, FileText, Shield } from "lucide-react";
import { Badge } from "../components/badge";
import { LogViewer, ExecutionTimeline } from "../components/log-viewer";
import { buildLogEntries, type RawLog } from "../components/log-utils";
import { ResultRenderer } from "../components/result-renderer";
import { InputModal } from "../components/input-modal";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { useProfiles } from "../hooks/use-profiles";
import { useMarkRead } from "../hooks/use-notifications";
import type { ExecutionStatus, ExecutionLog } from "@appstrate/shared-types";
import { formatDateField } from "../lib/markdown";
import { JsonView } from "../components/json-view";

export function ExecutionDetailPage() {
  const { t } = useTranslation(["flows", "common"]);
  const { scope, name, execId } = useParams<{ scope: string; name: string; execId: string }>();
  const packageId = `${scope}/${name}`;
  const location = useLocation();
  const executionNumber = (location.state as { executionNumber?: number } | null)?.executionNumber;
  const orgId = useCurrentOrgId();
  const { data: flow } = usePackageDetail("flow", packageId);
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

  const runFlow = useRunFlow(packageId!);
  const cancelExecution = useCancelExecution();
  const [inputOpen, setInputOpen] = useState(false);
  const [activeTab, setActiveTab] = useTabWithHash(
    ["execution", "logs", "result", "state"] as const,
    "execution",
  );
  const hasUserSelected = useRef(false);

  const { historicalLogs, historicalResult } = useMemo(() => {
    if (!logs) return { historicalLogs: [], historicalResult: null };
    const { entries, result } = buildLogEntries(logs as RawLog[]);
    return { historicalLogs: entries, historicalResult: result };
  }, [logs]);

  // Use result from logs or execution object
  const resultData = historicalResult || (execution?.result as Record<string, unknown> | null);
  const stateData = (execution?.state as Record<string, unknown> | null) ?? null;
  const allLogs = historicalLogs;
  const publicLogs = useMemo(
    () => allLogs.filter((e) => e.level && e.level !== "debug"),
    [allLogs],
  );

  // Reset hasUserSelected when switching executions
  useEffect(() => {
    hasUserSelected.current = false;
  }, [execId]);

  // Auto-switch to result when execution completes (unless user manually picked a tab)
  useEffect(() => {
    if (resultData && !isRunning && !hasUserSelected.current) {
      setActiveTab("result");
    }
  }, [resultData, isRunning, setActiveTab]);

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
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground mb-4">
        <Link to="/flows" className="text-muted-foreground hover:text-foreground">
          {t("detail.breadcrumb")}
        </Link>
        <span className="opacity-50">/</span>
        <Link to={`/flows/${packageId}`} className="text-muted-foreground hover:text-foreground">
          {flow?.displayName || packageId}
        </Link>
        <span className="opacity-50">/</span>
        <span>
          {executionNumber
            ? t("exec.breadcrumb", { number: executionNumber })
            : date || execId?.slice(0, 8)}
        </span>
      </nav>

      <div className="flex items-center gap-2 flex-wrap mb-4">
        <Badge status={displayStatus} />
        <span
          className={cn(
            "text-xs text-muted-foreground font-mono rounded bg-muted px-1.5 py-0.5",
            !execution.packageVersion && "italic",
          )}
        >
          {execution.packageVersion ? `v${execution.packageVersion}` : t("exec.draft")}
        </span>
        {userName && (
          <span className="text-sm text-muted-foreground">
            {t("exec.user", { name: userName })}
          </span>
        )}
        {execution.proxyLabel && (
          <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
            <Shield size={12} />
            {t("exec.proxy", { label: execution.proxyLabel })}
          </span>
        )}
        <span className="text-xs text-muted-foreground">{date}</span>
        {duration && <span className="text-xs text-muted-foreground">{duration}</span>}
        {!isRunning && execution.tokensUsed != null && (
          <span className="text-xs text-muted-foreground">
            {execution.tokensUsed.toLocaleString()} tokens
          </span>
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

      {displayStatus === "failed" && execution.error && (
        <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive mb-4">
          {execution.error}
        </div>
      )}

      <div className="flex items-center justify-between gap-4 mb-4">
        <Tabs
          value={activeTab}
          onValueChange={(v) => {
            hasUserSelected.current = true;
            setActiveTab(v as "execution" | "logs" | "result" | "state");
          }}
        >
          <TabsList>
            <TabsTrigger value="execution">
              {t("exec.tabExecution")}
              {publicLogs.length > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary">
                  {publicLogs.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="logs">
              {t("exec.tabLogs")}
              {allLogs.length > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary">
                  {allLogs.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="result">{t("exec.tabResult")}</TabsTrigger>
            <TabsTrigger value="state">{t("exec.tabState")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          {isRunning && (
            <Button
              variant="destructive"
              onClick={() => cancelExecution.mutate(execId!)}
              disabled={cancelExecution.isPending}
            >
              {cancelExecution.isPending && <Spinner />} {t("btn.cancel")}
            </Button>
          )}
          {!isRunning && flow && (
            <Button
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
            </Button>
          )}
        </div>
      </div>

      {activeTab === "execution" && (
        <ExecutionTimeline entries={publicLogs} isRunning={isRunning} />
      )}

      {activeTab === "logs" && <LogViewer entries={allLogs} />}

      {activeTab === "result" &&
        (resultData ? (
          <ResultRenderer data={resultData} outputSchema={flow?.output?.schema} />
        ) : (
          <EmptyState message={t("exec.emptyResult")} icon={FileText} compact />
        ))}

      {activeTab === "state" &&
        (stateData ? (
          <JsonView data={stateData} />
        ) : (
          <EmptyState message={t("exec.emptyState")} icon={Database} compact />
        ))}
    </>
  );
}
