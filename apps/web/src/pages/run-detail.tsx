// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useMemo, useEffect } from "react";
import { useParams, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { usePackageDetail } from "../hooks/use-packages";
import { useRun, useRunLogs } from "../hooks/use-runs";
import { useRunAgent, useCancelRun } from "../hooks/use-mutations";
import { Spinner } from "../components/spinner";
import { useRunRealtime, useRunLogsRealtime } from "../hooks/use-realtime";
import { useCurrentOrgId } from "../hooks/use-org";
import { Coins, Shield } from "lucide-react";
import { Badge } from "../components/status-badge";
import { LogViewer } from "../components/log-viewer";
import { buildLogEntries, type RawLog } from "../components/log-utils";
import { InputModal } from "../components/input-modal";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { useProfiles } from "../hooks/use-profiles";
import { useMarkRead } from "../hooks/use-notifications";
import type { RunStatus, RunLog } from "@appstrate/shared-types";
import { formatDateField } from "../lib/markdown";
import { JsonView } from "../components/json-view";
import { Markdown } from "../components/markdown";

export function RunDetailPage() {
  const { t } = useTranslation(["agents", "common"]);
  const { scope, name, runId } = useParams<{ scope: string; name: string; runId: string }>();
  const packageId = `${scope}/${name}`;
  const location = useLocation();
  const stateNumber = (location.state as { runNumber?: number } | null)?.runNumber;
  const orgId = useCurrentOrgId();
  const { data: agent } = usePackageDetail("agent", packageId);
  const { data: run, isLoading, error } = useRun(runId);
  const runNumber = run?.runNumber ?? stateNumber;
  const profileMap = useProfiles(run?.userId ? [run.userId] : []);
  const [liveStatus, setLiveStatus] = useState<RunStatus | null>(null);
  const [trackedExecId, setTrackedExecId] = useState(runId);

  // Reset live status when switching to a different run (e.g. re-run navigates
  // to a new runId on the same route, so React reuses the component instance).
  // Using the "state derived from props" pattern (setState during render) avoids
  // the cascading-render lint warning from calling setState inside useEffect.
  if (runId !== trackedExecId) {
    setTrackedExecId(runId);
    setLiveStatus(null);
  }

  const status = liveStatus || run?.status;
  const isRunning = status === "running" || status === "pending";

  const { data: logs } = useRunLogs(runId);

  const qc = useQueryClient();

  // Subscribe to new log INSERTs via SSE while run is running
  useRunLogsRealtime(
    isRunning ? runId : null,
    useCallback(
      (newLog: Record<string, unknown>) => {
        const log = newLog as unknown as RunLog;
        qc.setQueryData<RunLog[]>(["run-logs", orgId, runId], (prev) => {
          if (!prev) return [log];
          // Deduplicate: skip if already present (race between REST fetch and SSE)
          if (prev.some((l) => l.id === log.id)) return prev;
          return [...prev, log];
        });
      },
      [qc, orgId, runId],
    ),
  );

  const markRead = useMarkRead();

  // Auto-mark notification as read when viewing an run
  useEffect(() => {
    if (run && runId && run.notifiedAt && !run.readAt) {
      markRead.mutate(runId);
    }
  }, [run?.notifiedAt, run?.readAt, runId]); // eslint-disable-line react-hooks/exhaustive-deps

  const runAgent = useRunAgent(packageId!);
  const cancelRun = useCancelRun();
  const [inputOpen, setInputOpen] = useState(false);
  const { historicalLogs, structuredOutput, reportContent } = useMemo(() => {
    if (!logs) return { historicalLogs: [], structuredOutput: null, reportContent: null };
    const { entries, output, report } = buildLogEntries(logs as RawLog[]);
    return { historicalLogs: entries, structuredOutput: output, reportContent: report };
  }, [logs]);

  const execResult = run?.result as {
    output?: Record<string, unknown>;
    report?: string;
  } | null;
  const finalOutput = structuredOutput || execResult?.output || null;
  const hasOutput = finalOutput && Object.keys(finalOutput).length > 0;
  const finalReport = reportContent || execResult?.report || null;
  const hasResult = hasOutput || !!finalReport;
  const stateData = (run?.state as Record<string, unknown> | null) ?? null;
  const allLogs = historicalLogs;

  // Default tab: "result" if results exist, otherwise "logs".
  // useTabWithHash respects the URL hash if present, so this only affects first load without hash.
  const defaultTab = hasResult ? "result" : "logs";
  const [activeTab, setActiveTab] = useTabWithHash(
    ["result", "logs", "state", "usage"] as const,
    defaultTab,
  );

  // Sub-tab state: report by default if available, otherwise data.
  // Auto-default is derived; user override is tracked separately.
  const autoSubTab = finalReport ? "report" : hasOutput ? "data" : null;
  const [userSubTab, setUserSubTab] = useState<"report" | "data" | null>(null);
  const resultSubTab = userSubTab ?? autoSubTab ?? "data";
  const setResultSubTab = (v: "report" | "data") => setUserSubTab(v);

  // Live elapsed timer while running
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isRunning || !run?.startedAt) return;
    const start = new Date(run.startedAt).getTime();
    const tick = () => setElapsed(Date.now() - start);
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [isRunning, run?.startedAt]);

  // Subscribe to SSE for instant local status feedback
  useRunRealtime(
    isRunning ? runId : null,
    useCallback(
      (payload: Record<string, unknown>) => {
        const newStatus = payload.status as RunStatus;
        setLiveStatus(newStatus);
        // Safety net: final refetch of logs on terminal status (ensures completeness)
        const terminal =
          newStatus === "success" ||
          newStatus === "failed" ||
          newStatus === "timeout" ||
          newStatus === "cancelled";
        if (terminal) {
          qc.invalidateQueries({ queryKey: ["run", orgId, runId] });
          qc.invalidateQueries({ queryKey: ["run-logs", orgId, runId] });
        }
      },
      [qc, orgId, runId],
    ),
  );

  if (isLoading) return <LoadingState />;

  if (error || !run) return <ErrorState message={error?.message} />;

  const displayStatus = status || run.status;
  const date = run.startedAt ? formatDateField(run.startedAt) : "";
  const time = run.duration ?? elapsed;
  const duration = time ? `${(time / 1000).toFixed(1)}s` : "";
  const userName = run.userId ? profileMap.get(run.userId) : undefined;

  return (
    <>
      <PageHeader
        title={
          runNumber ? t("exec.breadcrumb", { number: runNumber }) : date || runId?.slice(0, 8) || ""
        }
        emoji="▶️"
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("detail.breadcrumb"), href: "/agents" },
          { label: agent?.displayName || packageId || "", href: `/agents/${packageId}` },
          {
            label: runNumber
              ? t("exec.breadcrumb", { number: runNumber })
              : date || runId?.slice(0, 8) || "",
          },
        ]}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge status={displayStatus} />
        <span
          className={cn(
            "text-muted-foreground bg-muted rounded px-1.5 py-0.5 font-mono text-xs",
            !run.packageVersion && "italic",
          )}
        >
          {run.packageVersion ? `v${run.packageVersion}` : t("exec.draft")}
        </span>
        {userName ? (
          <span className="text-muted-foreground text-sm">
            {t("exec.user", { name: userName })}
          </span>
        ) : null}
        {run.proxyLabel && (
          <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
            <Shield size={12} />
            {t("exec.proxy", { label: run.proxyLabel })}
          </span>
        )}
        <span className="text-muted-foreground text-xs">{date}</span>
        {duration && <span className="text-muted-foreground text-xs">{duration}</span>}
      </div>

      {agent && (
        <InputModal
          open={inputOpen}
          onClose={() => setInputOpen(false)}
          agent={agent}
          onSubmit={(input, files) => {
            runAgent.mutate({ input, files }, { onSuccess: () => setInputOpen(false) });
          }}
          isPending={runAgent.isPending}
          initialValues={(run.input as Record<string, unknown>) ?? undefined}
        />
      )}

      {displayStatus === "failed" && run.error && (
        <div className="bg-destructive/10 text-destructive mb-4 rounded-md px-4 py-3 text-sm">
          {run.error}
        </div>
      )}

      <div className="mb-4 flex items-center justify-between gap-4">
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as "logs" | "result" | "state" | "usage")}
        >
          <TabsList>
            {hasResult && <TabsTrigger value="result">{t("exec.tabResultGroup")}</TabsTrigger>}
            <TabsTrigger value="logs">
              {t("exec.tabLogs")}
              {allLogs.length > 0 && (
                <span className="bg-primary/15 text-primary ml-1.5 inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium">
                  {allLogs.length}
                </span>
              )}
            </TabsTrigger>
            {stateData && <TabsTrigger value="state">{t("exec.tabState")}</TabsTrigger>}
            <TabsTrigger value="usage">{t("exec.tabUsage")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          {isRunning && (
            <Button
              variant="destructive"
              onClick={() => cancelRun.mutate(runId!)}
              disabled={cancelRun.isPending}
            >
              {cancelRun.isPending && <Spinner />} {t("btn.cancel")}
            </Button>
          )}
        </div>
      </div>

      {activeTab === "result" && hasResult && (
        <div className="space-y-4">
          {finalReport && hasOutput && (
            <Tabs
              value={resultSubTab}
              onValueChange={(v) => setResultSubTab(v as "report" | "data")}
            >
              <TabsList>
                <TabsTrigger value="report">{t("exec.tabReport")}</TabsTrigger>
                <TabsTrigger value="data">{t("exec.tabResult")}</TabsTrigger>
              </TabsList>
            </Tabs>
          )}

          {(resultSubTab === "report" || !hasOutput) && finalReport && (
            <div className="border-border bg-muted/30 prose-headings:text-foreground prose-p:text-foreground prose-li:text-foreground prose-strong:text-foreground prose-td:text-foreground prose-th:text-foreground overflow-x-auto rounded-lg border p-6">
              <Markdown>{finalReport}</Markdown>
            </div>
          )}

          {(resultSubTab === "data" || !finalReport) && hasOutput && (
            <JsonView data={finalOutput!} />
          )}
        </div>
      )}

      {activeTab === "logs" && <LogViewer entries={allLogs} />}

      {activeTab === "state" && stateData && <JsonView data={stateData} />}

      {activeTab === "usage" &&
        (() => {
          const usage = run.tokenUsage as {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          } | null;

          const hasData = run.cost != null || run.tokensUsed != null || run.modelLabel != null;

          if (!hasData) {
            return <EmptyState message={t("exec.emptyUsage")} icon={Coins} compact />;
          }

          return (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {run.modelLabel != null && (
                <div className="border-border bg-muted/30 rounded-lg border p-4">
                  <p className="text-muted-foreground mb-1 text-xs">{t("exec.usageModel")}</p>
                  <p className="text-sm font-medium">{run.modelLabel}</p>
                </div>
              )}
              {run.cost != null && (
                <div className="border-border bg-muted/30 rounded-lg border p-4">
                  <p className="text-muted-foreground mb-1 text-xs">{t("exec.usageCost")}</p>
                  <p className="text-sm font-medium">${run.cost.toFixed(4)}</p>
                </div>
              )}
              {usage?.input_tokens != null && (
                <div className="border-border bg-muted/30 rounded-lg border p-4">
                  <p className="text-muted-foreground mb-1 text-xs">{t("exec.usageInputTokens")}</p>
                  <p className="text-sm font-medium">{usage.input_tokens.toLocaleString()}</p>
                </div>
              )}
              {usage?.output_tokens != null && (
                <div className="border-border bg-muted/30 rounded-lg border p-4">
                  <p className="text-muted-foreground mb-1 text-xs">
                    {t("exec.usageOutputTokens")}
                  </p>
                  <p className="text-sm font-medium">{usage.output_tokens.toLocaleString()}</p>
                </div>
              )}
              {usage?.cache_creation_input_tokens != null && (
                <div className="border-border bg-muted/30 rounded-lg border p-4">
                  <p className="text-muted-foreground mb-1 text-xs">
                    {t("exec.usageCacheCreation")}
                  </p>
                  <p className="text-sm font-medium">
                    {usage.cache_creation_input_tokens.toLocaleString()}
                  </p>
                </div>
              )}
              {usage?.cache_read_input_tokens != null && (
                <div className="border-border bg-muted/30 rounded-lg border p-4">
                  <p className="text-muted-foreground mb-1 text-xs">{t("exec.usageCacheRead")}</p>
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
