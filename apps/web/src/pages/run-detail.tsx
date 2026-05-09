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
import { useRunRealtime, type RunMetricEvent } from "../hooks/use-realtime";
import { useCurrentOrgId } from "../hooks/use-org";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { LogViewer } from "../components/log-viewer";
import { buildLogEntries, type RawLog } from "../components/log-utils";
import { RunModal } from "../components/run-modal";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState } from "../components/page-states";
import { RunInfoTab } from "../components/run-info-tab";
import { RunRow } from "../components/run-row";
import { useMarkRead } from "../hooks/use-notifications";
import {
  ACTIVE_RUN_STATUSES,
  type Run,
  type RunLog,
  type EnrichedRun,
} from "@appstrate/shared-types";
import { formatDateField } from "../lib/markdown";
import { JsonView } from "../components/json-view";
import { Markdown } from "../components/markdown";
import { useRunMemories, useRunPinned } from "../hooks/use-persistence";
import { MemoryPanel } from "../components/persistence/memory-panel";
import { Play } from "lucide-react";

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
  const applicationId = useCurrentApplicationId();
  const { data: agent } = usePackageDetail("agent", isInlinePath ? undefined : packageId);
  const { data: run, isLoading, error } = useRun(runId);
  const runNumber = run?.runNumber ?? stateNumber;

  // `useGlobalRunSync` (mounted in MainLayout) patches `run.status` directly
  // into the React Query cache from the LISTEN/NOTIFY stream, so reading
  // `run?.status` is sufficient — no local mirror needed.
  const status = run?.status;
  const isRunning = !!status && ACTIVE_RUN_STATUSES.has(status);

  const { data: logs } = useRunLogs(runId);

  const qc = useQueryClient();

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
  const { historicalLogs, structuredOutput, structuredReport } = useMemo(() => {
    if (!logs) return { historicalLogs: [], structuredOutput: null, structuredReport: null };
    const { entries, output, report } = buildLogEntries(logs as RawLog[]);
    return { historicalLogs: entries, structuredOutput: output, structuredReport: report };
  }, [logs]);

  const execResult = run?.result as {
    output?: Record<string, unknown>;
  } | null;
  const finalOutput = structuredOutput || execResult?.output || null;
  const hasOutput = finalOutput && Object.keys(finalOutput).length > 0;
  const hasReport = !!structuredReport;
  const hasResult = !!hasOutput || hasReport;
  const allLogs = historicalLogs;

  // Run-level memory rows (only those touched during this run).
  const { data: runMemories } = useRunMemories(packageId, runId);
  const { data: runPinned } = useRunPinned(packageId, runId);
  const runMemoryCount = (runMemories?.length ?? 0) + (runPinned?.length ?? 0);
  const hasRunMemory = runMemoryCount > 0;

  // Default tab: "result" if results exist (report and/or output), otherwise "logs".
  // useTabWithHash respects the URL hash if present.
  const defaultTab = hasResult ? "result" : "logs";
  const [activeTab, setActiveTab] = useTabWithHash(
    ["result", "logs", "memory", "info"] as const,
    defaultTab,
  );

  // Result sub-tab: report first if available, otherwise data. User
  // override is tracked separately so the auto-default can react to late
  // events without clobbering an explicit click.
  const autoSubTab: "report" | "data" = hasReport ? "report" : "data";
  const [userSubTab, setUserSubTab] = useState<"report" | "data" | null>(null);
  const resultSubTab = userSubTab ?? autoSubTab;

  // Per-run SSE for log inserts + live metric updates. Status patches
  // come from `useGlobalRunSync` (mounted in MainLayout), which writes
  // directly into the same `["run", orgId, applicationId, runId]`
  // cache key. Terminal-status refetch is also already triggered
  // globally via `invalidateRunAndNotificationQueries`.
  useRunRealtime(isRunning ? runId : null, {
    onNewLog: useCallback(
      (newLog: Record<string, unknown>) => {
        const log = newLog as unknown as RunLog;
        qc.setQueryData<RunLog[]>(["run-logs", orgId, applicationId, runId], (prev) => {
          if (!prev) return [log];
          if (prev.some((l) => l.id === log.id)) return prev;
          return [...prev, log];
        });
      },
      [qc, orgId, applicationId, runId],
    ),
    onMetric: useCallback(
      (metric: RunMetricEvent) => {
        // Patch the cached run row with the running token usage + cost
        // so the Info tab reflects live progress without polling.
        // `runs.cost` is the cached aggregate written at finalize on
        // the server; mid-run we render the broadcaster's
        // `cost_so_far` instead. The next terminal-status invalidation
        // refetches the canonical row so this in-cache shadow is
        // bounded by the run's lifetime.
        qc.setQueryData<Run>(["run", orgId, applicationId, runId], (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            tokenUsage: metric.tokenUsage ?? prev.tokenUsage,
            cost: metric.costSoFar,
          } as Run;
        });
      },
      [qc, orgId, applicationId, runId],
    ),
  });

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
        <RunModal
          open={inputOpen}
          onClose={() => setInputOpen(false)}
          agent={agent}
          onSubmit={(input) => {
            runAgent.mutate(
              { input, version: run.versionLabel ?? undefined },
              { onSuccess: () => setInputOpen(false) },
            );
          }}
          isPending={runAgent.isPending}
          initialInput={(run.input as Record<string, unknown>) ?? undefined}
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
          {/* Live token + cost readout — only while the run is active. The
              `onMetric` SSE handler patches `run.tokenUsage` and `run.cost`
              in place; this pill re-renders at the throttled cadence (250 ms
              window) without polling. Shown for every running run, including
              remote-origin ones (which still stream metrics even though the
              Cancel button is hidden for them). */}
          {isRunning &&
            (() => {
              const liveUsage = run.tokenUsage as {
                input_tokens?: number;
                output_tokens?: number;
              } | null;
              const totalTokens = (liveUsage?.input_tokens ?? 0) + (liveUsage?.output_tokens ?? 0);
              if (totalTokens === 0 && run.cost == null) return null;
              return (
                <div className="text-muted-foreground bg-muted/50 flex items-center gap-2 rounded-md px-2.5 py-1 text-xs tabular-nums">
                  <span className="bg-primary size-1.5 animate-pulse rounded-full" aria-hidden />
                  {totalTokens > 0 && <span>{totalTokens.toLocaleString()} tokens</span>}
                  {totalTokens > 0 && run.cost != null && <span aria-hidden>·</span>}
                  {run.cost != null && (
                    <span className="text-foreground font-medium">${run.cost.toFixed(4)}</span>
                  )}
                </div>
              );
            })()}
          {!isRunning && !isInline && agent && (
            <Button variant="outline" size="sm" onClick={() => setInputOpen(true)}>
              <Play className="size-3.5" />
              {t("exec.rerun")}
            </Button>
          )}
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
          {hasReport && hasOutput && (
            <Tabs value={resultSubTab} onValueChange={(v) => setUserSubTab(v as "report" | "data")}>
              <TabsList>
                <TabsTrigger value="report">{t("exec.tabReport")}</TabsTrigger>
                <TabsTrigger value="data">{t("exec.tabResult")}</TabsTrigger>
              </TabsList>
            </Tabs>
          )}

          {resultSubTab === "report" && hasReport && (
            <div className="border-border bg-muted/30 overflow-auto rounded-lg border p-4">
              <Markdown>{structuredReport!}</Markdown>
            </div>
          )}

          {resultSubTab === "data" && hasOutput && <JsonView data={finalOutput!} />}
        </div>
      )}

      {activeTab === "logs" && <LogViewer entries={allLogs} />}

      {activeTab === "memory" && <MemoryPanel packageId={packageId!} runId={runId!} />}

      {activeTab === "info" && <RunInfoTab run={enrichedRun} />}
    </div>
  );
}
