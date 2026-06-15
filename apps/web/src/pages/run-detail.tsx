// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useMemo, useEffect } from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
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
import { useRunRealtime, type RunMetricEvent } from "../hooks/use-realtime";
import { useCurrentOrgId } from "../hooks/use-org";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { LogViewer } from "../components/log-viewer";
import { buildLogEntries, type RawLog } from "../components/log-utils";
import { RunModal } from "../components/run-modal";
import { LoadingState, ErrorState } from "../components/page-states";
import { RunInfoTab } from "../components/run-info-tab";
import { Badge } from "../components/status-badge";
import { useMarkRead } from "../hooks/use-notifications";
import { ACTIVE_RUN_STATUSES, type RunLog, type EnrichedRun } from "@appstrate/shared-types";
import { JsonView } from "../components/json-view";
import { Markdown } from "../components/markdown";
import { useRunMemories, useRunPinned } from "../hooks/use-persistence";
import { MemoryPanel } from "../components/persistence/memory-panel";
import { Play, ArrowLeft, Activity } from "lucide-react";

const META_TINTS = [
  "bg-primary-soft text-primary",
  "bg-spark-soft text-spark",
  "bg-success-soft text-success",
  "bg-warning-soft text-warning",
];

function tintFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return META_TINTS[h % META_TINTS.length]!;
}

function MetaCell({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="border-border/70 border-b border-r p-3 last:border-r-0 sm:border-b-0">
      <div className="text-muted-foreground text-[0.66rem] font-semibold tracking-wide uppercase">
        {k}
      </div>
      <div className={cn("mt-0.5 text-sm font-semibold", mono && "font-mono font-medium")}>{v}</div>
    </div>
  );
}

export function RunDetailPage() {
  const { t } = useTranslation(["agents", "common"]);
  const { scope, name, runId } = useParams<{ scope: string; name: string; runId: string }>();
  const packageId = `${scope}/${name}`;
  // Skip the agent detail fetch for inline shadow packages — the shadow is
  // filtered from catalog endpoints so the query would 404 on every view.
  const isInlinePath = packageId.startsWith("@inline/");
  const location = useLocation();
  const navigate = useNavigate();
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
  const isRunning = !!status && (ACTIVE_RUN_STATUSES as ReadonlySet<string>).has(status);

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
        qc.setQueryData<EnrichedRun>(["run", orgId, applicationId, runId], (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            token_usage: metric.token_usage ?? prev.token_usage,
            cost: metric.costSoFar,
          } as EnrichedRun;
        });
      },
      [qc, orgId, applicationId, runId],
    ),
  });

  if (isLoading) return <LoadingState />;

  if (error || !run) return <ErrorState message={error?.message} />;

  const enrichedRun = run;
  const isInline = enrichedRun.package_ephemeral === true;
  const agentName = isInline
    ? enrichedRun.agent_name
      ? `${enrichedRun.agent_name} (${t("runs.inlineBadge").toLowerCase()})`
      : t("runs.inlineBadge")
    : agent?.display_name || packageId || "";

  const STATUS_LABEL: Record<string, string> = {
    success: t("exec.statusSuccess", { defaultValue: "Réussi" }),
    failed: t("exec.statusFailed", { defaultValue: "Échoué" }),
    running: t("exec.statusRunning", { defaultValue: "En cours" }),
    pending: t("exec.statusPending", { defaultValue: "En attente" }),
    timeout: t("exec.statusTimeout", { defaultValue: "Expiré" }),
    cancelled: t("exec.statusCancelled", { defaultValue: "Annulé" }),
  };
  const statusLabel = STATUS_LABEL[status ?? "pending"] ?? status ?? "";

  const durationText = isRunning
    ? "—"
    : run.duration != null
      ? run.duration >= 60000
        ? `${Math.floor(run.duration / 60000)}m ${Math.round((run.duration % 60000) / 1000)}s`
        : `${(run.duration / 1000).toFixed(1)}s`
      : "—";

  const triggerLabel = enrichedRun.scheduleId
    ? t("runs.triggerSchedule", { defaultValue: "Planification" })
    : enrichedRun.apiKeyId
      ? t("runs.triggerApi", { defaultValue: "API" })
      : t("runs.triggerManual", { defaultValue: "Manuel" });

  const tint = tintFor(packageId);
  const liveUsage = run.token_usage as {
    input_tokens?: number;
    output_tokens?: number;
  } | null;
  const totalTokens = (liveUsage?.input_tokens ?? 0) + (liveUsage?.output_tokens ?? 0);

  return (
    <div className="mx-auto w-full max-w-[1100px] p-8 pb-16">
      <button
        type="button"
        onClick={() => navigate(isInline ? "/runs" : `/agents/${packageId}`)}
        className="text-muted-foreground hover:text-foreground mb-4 inline-flex items-center gap-1.5 text-sm font-medium transition-colors"
      >
        <ArrowLeft className="size-4" /> {t("btn.back", { ns: "common", defaultValue: "Retour" })}
      </button>

      {/* Entity header */}
      <div className="mb-5 flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-[10px]",
              tint,
            )}
          >
            <Activity className="size-[22px]" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-[1.4rem] font-bold tracking-tight">{agentName}</h1>
            <div className="text-muted-foreground mt-0.5 truncate font-mono text-xs">
              {runNumber != null ? `run #${runNumber} · ` : ""}
              {runId}
            </div>
          </div>
          <Badge status={run.status} />
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="text-muted-foreground bg-muted/50 flex items-center gap-2 rounded-md px-2.5 py-1 text-xs tabular-nums">
            {isRunning && (
              <span className="bg-primary size-1.5 animate-pulse rounded-full" aria-hidden />
            )}
            <span>{totalTokens.toLocaleString()} tokens</span>
            <span aria-hidden>·</span>
            <span className="text-foreground font-medium">${(run.cost ?? 0).toFixed(4)}</span>
          </div>
          {!isRunning && !isInline && agent && (
            <Button variant="outline" size="sm" onClick={() => setInputOpen(true)}>
              <Play className="size-3.5" />
              {t("exec.rerun")}
            </Button>
          )}
          {isRunning && enrichedRun.runOrigin !== "remote" && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => cancelRun.mutate(runId!)}
              disabled={cancelRun.isPending}
            >
              {cancelRun.isPending && <Spinner />} {t("btn.cancel")}
            </Button>
          )}
        </div>
      </div>

      {/* Meta grid */}
      <div className="border-border bg-card mb-5 grid grid-cols-2 overflow-hidden rounded-[var(--radius)] border shadow-sm sm:grid-cols-4">
        <MetaCell k={t("exec.metaStatus", { defaultValue: "Statut" })} v={statusLabel} />
        <MetaCell k={t("exec.metaDuration", { defaultValue: "Durée" })} v={durationText} mono />
        <MetaCell k={t("exec.metaTrigger", { defaultValue: "Déclencheur" })} v={triggerLabel} />
        <MetaCell
          k={t("exec.metaCost", { defaultValue: "Coût" })}
          v={`$${(run.cost ?? 0).toFixed(4)}`}
          mono
        />
      </div>

      {agent && (
        <RunModal
          open={inputOpen}
          onClose={() => setInputOpen(false)}
          agent={agent}
          onSubmit={(input) => {
            runAgent.mutate(
              { input, version: run.version_label ?? undefined },
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

      <div className="mb-4">
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
