import { useState, useCallback, useMemo, useEffect } from "react";
import { useParams, Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { usePackageDetail } from "../hooks/use-packages";
import { useExecution, useExecutions, useExecutionLogs } from "../hooks/use-executions";
import { useRunFlow, useCancelExecution } from "../hooks/use-mutations";
import { Spinner } from "../components/spinner";
import { useExecutionRealtime, useExecutionLogsRealtime } from "../hooks/use-realtime";
import { useCurrentOrgId } from "../hooks/use-org";
import { Coins, Shield } from "lucide-react";
import { Badge } from "../components/badge";
import { LogViewer } from "../components/log-viewer";
import { buildLogEntries, type RawLog } from "../components/log-utils";
import { InputModal } from "../components/input-modal";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { useProfiles } from "../hooks/use-profiles";
import { useMarkRead } from "../hooks/use-notifications";
import type { ExecutionStatus, ExecutionLog } from "@appstrate/shared-types";
import { formatDateField } from "../lib/markdown";
import { JsonView } from "../components/json-view";
import { Markdown } from "../components/markdown";

export function ExecutionDetailPage() {
  const { t } = useTranslation(["flows", "common"]);
  const { scope, name, execId } = useParams<{ scope: string; name: string; execId: string }>();
  const packageId = `${scope}/${name}`;
  const location = useLocation();
  const stateNumber = (location.state as { executionNumber?: number } | null)?.executionNumber;
  const orgId = useCurrentOrgId();
  const { data: flow } = usePackageDetail("flow", packageId);
  const { data: execution, isLoading, error } = useExecution(execId);
  const { data: flowExecutions } = useExecutions(packageId);
  // Compute execution number from flow executions list (fallback if not passed via navigation state)
  const computedNumber = useMemo(() => {
    if (!flowExecutions || !execId) return undefined;
    const index = flowExecutions.findIndex((e) => e.id === execId);
    if (index === -1) return undefined;
    return flowExecutions.length - index;
  }, [flowExecutions, execId]);
  const executionNumber = stateNumber ?? computedNumber;
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
    ["logs", "result", "report", "state", "usage"] as const,
    "logs",
  );

  const { historicalLogs, structuredOutput, reportContent } = useMemo(() => {
    if (!logs) return { historicalLogs: [], structuredOutput: null, reportContent: null };
    const { entries, output, report } = buildLogEntries(logs as RawLog[]);
    return { historicalLogs: entries, structuredOutput: output, reportContent: report };
  }, [logs]);

  const execResult = execution?.result as {
    output?: Record<string, unknown>;
    report?: string;
  } | null;
  const finalOutput = structuredOutput || execResult?.output || null;
  const hasOutput = finalOutput && Object.keys(finalOutput).length > 0;
  const finalReport = reportContent || execResult?.report || null;
  const stateData = (execution?.state as Record<string, unknown> | null) ?? null;
  const allLogs = historicalLogs;

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
      <PageHeader
        title={
          executionNumber
            ? t("exec.breadcrumb", { number: executionNumber })
            : date || execId?.slice(0, 8) || ""
        }
        emoji="▶️"
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("detail.breadcrumb"), href: "/flows" },
          { label: flow?.displayName || packageId || "", href: `/flows/${packageId}` },
          {
            label: executionNumber
              ? t("exec.breadcrumb", { number: executionNumber })
              : date || execId?.slice(0, 8) || "",
          },
        ]}
      />

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
        {userName ? (
          <span className="text-sm text-muted-foreground">
            {t("exec.user", { name: userName })}
          </span>
        ) : null}
        {execution.proxyLabel && (
          <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
            <Shield size={12} />
            {t("exec.proxy", { label: execution.proxyLabel })}
          </span>
        )}
        <span className="text-xs text-muted-foreground">{date}</span>
        {duration && <span className="text-xs text-muted-foreground">{duration}</span>}
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
          onValueChange={(v) => setActiveTab(v as "logs" | "result" | "report" | "state" | "usage")}
        >
          <TabsList>
            <TabsTrigger value="logs">
              {t("exec.tabLogs")}
              {allLogs.length > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary">
                  {allLogs.length}
                </span>
              )}
            </TabsTrigger>
            {hasOutput && <TabsTrigger value="result">{t("exec.tabResult")}</TabsTrigger>}
            {finalReport && <TabsTrigger value="report">{t("exec.tabReport")}</TabsTrigger>}
            {stateData && <TabsTrigger value="state">{t("exec.tabState")}</TabsTrigger>}
            <TabsTrigger value="usage">{t("exec.tabUsage")}</TabsTrigger>
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

      {activeTab === "logs" && <LogViewer entries={allLogs} />}

      {activeTab === "result" && hasOutput && <JsonView data={finalOutput!} />}

      {activeTab === "report" && finalReport && (
        <div className="rounded-lg border border-border bg-muted/30 p-6 prose-headings:text-foreground prose-p:text-foreground prose-li:text-foreground prose-strong:text-foreground prose-td:text-foreground prose-th:text-foreground">
          <Markdown>{finalReport}</Markdown>
        </div>
      )}

      {activeTab === "state" && stateData && <JsonView data={stateData} />}

      {activeTab === "usage" &&
        (() => {
          const usage = execution.tokenUsage as {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          } | null;

          const hasData =
            execution.cost != null || execution.tokensUsed != null || execution.modelLabel != null;

          if (!hasData) {
            return <EmptyState message={t("exec.emptyUsage")} icon={Coins} compact />;
          }

          return (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {execution.modelLabel != null && (
                <div className="rounded-lg border border-border bg-muted/30 p-4">
                  <p className="text-xs text-muted-foreground mb-1">{t("exec.usageModel")}</p>
                  <p className="text-sm font-medium">{execution.modelLabel}</p>
                </div>
              )}
              {execution.cost != null && (
                <div className="rounded-lg border border-border bg-muted/30 p-4">
                  <p className="text-xs text-muted-foreground mb-1">{t("exec.usageCost")}</p>
                  <p className="text-sm font-medium">${execution.cost.toFixed(4)}</p>
                </div>
              )}
              {usage?.input_tokens != null && (
                <div className="rounded-lg border border-border bg-muted/30 p-4">
                  <p className="text-xs text-muted-foreground mb-1">{t("exec.usageInputTokens")}</p>
                  <p className="text-sm font-medium">{usage.input_tokens.toLocaleString()}</p>
                </div>
              )}
              {usage?.output_tokens != null && (
                <div className="rounded-lg border border-border bg-muted/30 p-4">
                  <p className="text-xs text-muted-foreground mb-1">
                    {t("exec.usageOutputTokens")}
                  </p>
                  <p className="text-sm font-medium">{usage.output_tokens.toLocaleString()}</p>
                </div>
              )}
              {usage?.cache_creation_input_tokens != null && (
                <div className="rounded-lg border border-border bg-muted/30 p-4">
                  <p className="text-xs text-muted-foreground mb-1">
                    {t("exec.usageCacheCreation")}
                  </p>
                  <p className="text-sm font-medium">
                    {usage.cache_creation_input_tokens.toLocaleString()}
                  </p>
                </div>
              )}
              {usage?.cache_read_input_tokens != null && (
                <div className="rounded-lg border border-border bg-muted/30 p-4">
                  <p className="text-xs text-muted-foreground mb-1">{t("exec.usageCacheRead")}</p>
                  <p className="text-sm font-medium">
                    {usage.cache_read_input_tokens.toLocaleString()}
                  </p>
                </div>
              )}
            </div>
          );
        })()}
    </>
  );
}
