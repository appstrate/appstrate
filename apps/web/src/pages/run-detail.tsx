// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useMemo, useEffect } from "react";
import { useParams, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { usePackageDetail } from "../hooks/use-packages";
import { useRun, useRunLogs } from "../hooks/use-runs";
import { useRunAgent, useCancelRun } from "../hooks/use-mutations";
import { Spinner } from "../components/spinner";
import { useRunRealtime, useRunLogsRealtime } from "../hooks/use-realtime";
import { useCurrentOrgId } from "../hooks/use-org";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { LogViewer } from "../components/log-viewer";
import { buildLogEntries, type RawLog } from "../components/log-utils";
import { InputModal } from "../components/input-modal";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState } from "../components/page-states";
import { RunInfoTab } from "../components/run-info-tab";
import { RunRow } from "../components/run-row";
import { useMarkRead } from "../hooks/use-notifications";
import type { RunStatus, RunLog, EnrichedRun } from "@appstrate/shared-types";
import { formatDateField } from "../lib/markdown";
import { Markdown } from "../components/markdown";
import { JsonView } from "../components/json-view";
import { useRunMemories, useRunPinned } from "../hooks/use-persistence";
import { MemoryPanel } from "../components/persistence/memory-panel";

export function RunDetailPage() {
  const { t } = useTranslation(["agents", "common"]);
  const { scope, name, runId } = useParams<{ scope: string; name: string; runId: string }>();
  const packageId = `${scope}/${name}`;
  // Skip the agent detail fetch for inline shadow packages — the shadow is
  // filtered from catalog endpoints so the query would 404 on every view.
  const isInlinePath = packageId.startsWith("@inline/");
  const location = useLocation();
  const stateNumber = (location.state as { runNumber?: number } | null)?.runNumber;
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  const { data: agent } = usePackageDetail("agent", isInlinePath ? undefined : packageId);
  const { data: run, isLoading, error } = useRun(runId);
  const runNumber = run?.runNumber ?? stateNumber;
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
        qc.setQueryData<RunLog[]>(["run-logs", orgId, appId, runId], (prev) => {
          if (!prev) return [log];
          // Deduplicate: skip if already present (race between REST fetch and SSE)
          if (prev.some((l) => l.id === log.id)) return prev;
          return [...prev, log];
        });
      },
      [qc, orgId, appId, runId],
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
  const allLogs = historicalLogs;

  // Run-level memory rows (only those touched during this run).
  const { data: runMemories } = useRunMemories(packageId, runId);
  const { data: runPinned } = useRunPinned(packageId, runId);
  const runMemoryCount = (runMemories?.length ?? 0) + (runPinned?.length ?? 0);
  const hasRunMemory = runMemoryCount > 0;

  // Default tab: "result" if results exist, otherwise "logs".
  // useTabWithHash respects the URL hash if present, so this only affects first load without hash.
  const defaultTab = hasResult ? "result" : "logs";
  const [activeTab, setActiveTab] = useTabWithHash(
    ["result", "logs", "memory", "info"] as const,
    defaultTab,
  );

  // Sub-tab state: report by default if available, otherwise data.
  // Auto-default is derived; user override is tracked separately.
  const autoSubTab = finalReport ? "report" : hasOutput ? "data" : null;
  const [userSubTab, setUserSubTab] = useState<"report" | "data" | null>(null);
  const resultSubTab = userSubTab ?? autoSubTab ?? "data";
  const setResultSubTab = (v: "report" | "data") => setUserSubTab(v);

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
          qc.invalidateQueries({ queryKey: ["run", orgId, appId, runId] });
          qc.invalidateQueries({ queryKey: ["run-logs", orgId, appId, runId] });
        }
      },
      [qc, orgId, appId, runId],
    ),
  );

  if (isLoading) return <LoadingState />;

  if (error || !run) return <ErrorState message={error?.message} />;

  const enrichedRun = run as EnrichedRun;
  const date = run.startedAt ? formatDateField(run.startedAt) : "";
  const isInline = enrichedRun.packageEphemeral === true;

  // For inline runs the agent crumb *is* the last crumb (the run itself),
  // so omit href — PageHeader renders it as the current-page indicator.
  const agentCrumb = isInline
    ? {
        label: enrichedRun.agentName
          ? `${enrichedRun.agentName} (${t("runs.inlineBadge").toLowerCase()})`
          : t("runs.inlineBadge"),
      }
    : { label: agent?.displayName || packageId || "", href: `/agents/${packageId}` };

  const runCrumbLabel = runNumber
    ? t("exec.breadcrumb", { number: runNumber })
    : date || runId?.slice(0, 8) || "";

  // Inline agents are 1:1 with their single run — the agent crumb already
  // identifies the run, so a trailing "Run #N" crumb is redundant.
  const breadcrumbs = [
    { label: t("nav.orgSection", { ns: "common" }), href: "/" },
    { label: t("detail.breadcrumb"), href: "/agents" },
    agentCrumb,
    ...(isInline ? [] : [{ label: runCrumbLabel }]),
  ];

  return (
    <div className="p-6">
      <PageHeader title={runCrumbLabel} emoji="▶️" breadcrumbs={breadcrumbs} />

      <div className="border-border mb-4 rounded-md border">
        <RunRow run={enrichedRun} disableLink />
      </div>

      {agent && (
        <InputModal
          open={inputOpen}
          onClose={() => setInputOpen(false)}
          agent={agent}
          onSubmit={(input) => {
            runAgent.mutate({ input }, { onSuccess: () => setInputOpen(false) });
          }}
          isPending={runAgent.isPending}
          initialValues={(run.input as Record<string, unknown>) ?? undefined}
        />
      )}

      {run.status === "failed" && run.error && (
        <div className="bg-destructive/10 text-destructive mb-4 rounded-md px-4 py-3 text-sm">
          {run.error}
        </div>
      )}

      <div className="mb-4 flex items-center justify-between gap-4">
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as "logs" | "result" | "memory" | "info")}
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
            {hasRunMemory && (
              <TabsTrigger value="memory">
                {t("exec.tabMemory")}
                <span className="bg-primary/15 text-primary ml-1.5 inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium">
                  {runMemoryCount}
                </span>
              </TabsTrigger>
            )}
            <TabsTrigger value="info">{t("exec.tabInfo")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          {/* Cancel hidden for remote-origin runs — the process runs on the
              caller's host and the platform cannot signal it. A soft-cancel
              (server flag + CLI poll) is tracked as a follow-up. */}
          {isRunning && enrichedRun.runOrigin !== "remote" && (
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

      {activeTab === "memory" && <MemoryPanel packageId={packageId!} runId={runId!} />}

      {activeTab === "info" && <RunInfoTab run={enrichedRun} />}
    </div>
  );
}
