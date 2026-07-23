// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useMemo, useEffect } from "react";
import { useParams, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@appstrate/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { usePackageDetail } from "../hooks/use-packages";
import { useRun, useRunLogs } from "../hooks/use-runs";
import { useRunAgent, useCancelRun } from "../hooks/use-mutations";
import { Spinner } from "../components/spinner";
import { useRunRealtime, type RunMetricEvent, type RunLogEvent } from "../hooks/use-realtime";
import { useCurrentOrgId } from "../hooks/use-org";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { LogViewer } from "../components/log-viewer";
import { buildLogEntries } from "../components/log-utils";
import { RunModal } from "../components/run-modal";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState } from "../components/page-states";
import { RunInfoTab } from "../components/run-info-tab";
import { RunDocumentsTab } from "../components/run-documents-tab";
import { useDocuments } from "../hooks/use-documents";
import { RunRow } from "../components/run-row";
import { RunDegradedBanner } from "../components/run-degraded-banner";
import { useMarkReadByRun } from "../hooks/use-notifications";
import { ACTIVE_RUN_STATUSES, type EnrichedRun } from "@appstrate/shared-types";
import type { components } from "../api/client";
import { formatDateField } from "../lib/markdown";
import { JsonView } from "../components/json-view";
import { useRunMemories, useRunPinned } from "../hooks/use-persistence";
import { runKeys } from "../lib/query-keys";
import { MemoryPanel } from "../components/persistence/memory-panel";
import { Play } from "lucide-react";

/** Wire shape of a persisted log row (spec `RunLog`); `createdAt` is an ISO string. */
type RunLogEntry = components["schemas"]["RunLog"];

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
  const isRunning = !!status && (ACTIVE_RUN_STATUSES as ReadonlySet<string>).has(status);

  const { data: logs } = useRunLogs(runId);

  const qc = useQueryClient();

  const markRead = useMarkReadByRun();

  // Auto-mark notification as read when viewing a terminal run. Keyed on
  // `status`: the SSE run patch carries `status` (see `runUpdateToRunPatch`),
  // so a run that finalizes while the page is open marks read the moment
  // status flips terminal. Idempotent server-side (no-op for a non-recipient /
  // already-read), and `status` is stable once terminal so the effect does not
  // re-fire on subsequent renders.
  useEffect(() => {
    const terminal = !!status && !(ACTIVE_RUN_STATUSES as ReadonlySet<string>).has(status);
    if (run && runId && terminal) {
      markRead.mutate({ params: { path: { runId } } });
    }
  }, [status, runId]); // eslint-disable-line react-hooks/exhaustive-deps

  const runAgent = useRunAgent(packageId);
  const cancelRun = useCancelRun();
  const [inputOpen, setInputOpen] = useState(false);
  const { historicalLogs, structuredOutput } = useMemo(() => {
    if (!logs) return { historicalLogs: [], structuredOutput: null };
    const { entries, output } = buildLogEntries(logs);
    return { historicalLogs: entries, structuredOutput: output };
  }, [logs]);

  const execResult = run?.result as {
    output?: Record<string, unknown>;
  } | null;
  const finalOutput = structuredOutput || execResult?.output || null;
  const hasOutput = !!finalOutput && Object.keys(finalOutput).length > 0;
  const allLogs = historicalLogs;

  // Run-level memory rows (only those touched during this run).
  const { data: runMemories } = useRunMemories(packageId, runId);
  const { data: runPinned } = useRunPinned(packageId, runId);
  const runMemoryCount = (runMemories?.length ?? 0) + (runPinned?.length ?? 0);
  const hasRunMemory = runMemoryCount > 0;

  // Document count for the tab badge. The tab body runs the same query (identical
  // key) so React Query dedups it into a single request.
  const { data: documentsPage } = useDocuments({ runId, limit: 100 });
  const documentCount = documentsPage?.data.length ?? 0;

  // Default tab: "result" if the run produced structured output, otherwise "logs".
  // useTabWithHash respects the URL hash if present.
  const defaultTab = hasOutput ? "result" : "logs";
  const [activeTab, setActiveTab] = useTabWithHash(
    ["result", "logs", "memory", "documents", "info"] as const,
    defaultTab,
  );

  // Per-run SSE for log inserts + live metric updates. Status patches
  // come from `useGlobalRunSync` (mounted in MainLayout), which writes
  // directly into the same `["run", orgId, applicationId, runId]`
  // cache key. Terminal-status refetch is also already triggered
  // globally via `invalidateRunAndNotificationQueries`.
  useRunRealtime(isRunning ? runId : null, {
    onNewLog: useCallback(
      (newLog: RunLogEvent) => {
        // `newLog` is runtime-validated by `runLogEventSchema`. Type the patch
        // against the wire `RunLog` (spec) so this writer and `useRunLogs` agree
        // on the element type of the shared `runKeys.logs` cache. Spread carries
        // the matching fields (id/createdAt are ISO strings on both); only the
        // spec's lossy `data` (`object`) needs a localized narrow — the SSE frame
        // strips `data` server-side (`stripPayload`), so it is null in practice.
        const entry: RunLogEntry = {
          ...newLog,
          data: (newLog.data ?? null) as RunLogEntry["data"],
        };
        qc.setQueryData<RunLogEntry[]>(runKeys.logs(orgId, applicationId, runId), (prev) => {
          if (!prev) return [entry];
          if (prev.some((l) => l.id === entry.id)) return prev;
          return [...prev, entry];
        });
        // A published document arrives as a `type='result' event='document'`
        // log frame — invalidate the run's documents list so the tab (and its
        // badge) picks up the new file without a dedicated SSE channel.
        if (entry.type === "result" && entry.event === "document") {
          void qc.invalidateQueries({ queryKey: ["get", "/api/documents"] });
        }
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
        qc.setQueryData<EnrichedRun>(runKeys.detail(orgId, applicationId, runId), (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            token_usage: metric.tokenUsage ?? prev.token_usage,
            cost: metric.costSoFar,
          };
        });
      },
      [qc, orgId, applicationId, runId],
    ),
  });

  if (isLoading) return <LoadingState />;

  if (error || !run) return <ErrorState message={error?.message} />;

  const enrichedRun = run;
  const date = run.started_at ? formatDateField(run.started_at) : "";
  const isInline = enrichedRun.package_ephemeral === true;

  // For inline runs the agent crumb *is* the last crumb (the run itself),
  // so omit href — PageHeader renders it as the current-page indicator.
  const agentCrumb = isInline
    ? {
        label: enrichedRun.agent_name
          ? `${enrichedRun.agent_name} (${t("runs.inlineBadge").toLowerCase()})`
          : t("runs.inlineBadge"),
      }
    : { label: agent?.display_name || packageId || "", href: `/agents/${packageId}` };

  const runCrumbLabel = runNumber
    ? t("run.breadcrumb", { number: runNumber })
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
            // Re-run the SAME definition the original run executed:
            // `version_ref` is "draft" or a concrete semver. Pre-#636 this
            // passed version_label, which silently re-ran the published
            // version for runs that had executed a dirty draft.
            runAgent.mutate(
              { input, version: run.version_ref },
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

      <RunDegradedBanner metadata={run.metadata} />

      <div className="mb-4 flex items-center justify-between gap-4">
        <Tabs
          value={activeTab}
          onValueChange={(v) =>
            setActiveTab(v as "logs" | "result" | "memory" | "documents" | "info")
          }
        >
          <TabsList>
            {hasOutput && <TabsTrigger value="result">{t("run.tabResult")}</TabsTrigger>}
            <TabsTrigger value="logs">
              {t("run.tabLogs")}
              {allLogs.length > 0 && (
                <span className="bg-primary/15 text-primary ml-1.5 inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium">
                  {allLogs.length}
                </span>
              )}
            </TabsTrigger>
            {hasRunMemory && (
              <TabsTrigger value="memory">
                {t("run.tabMemory")}
                <span className="bg-primary/15 text-primary ml-1.5 inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium">
                  {runMemoryCount}
                </span>
              </TabsTrigger>
            )}
            <TabsTrigger value="documents">
              {t("run.tabDocuments")}
              {documentCount > 0 && (
                <span className="bg-primary/15 text-primary ml-1.5 inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium">
                  {documentCount}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="info">{t("run.tabInfo")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          {/* Token + cost readout — shown at all times (pending, running,
              terminal). While the run is active the pulse dot animates and
              `onMetric` SSE patches `run.token_usage` + `run.cost` in place
              at the throttled 250 ms cadence; once finalized, the same
              fields hold the authoritative aggregate written by
              `finalizeRun`. Defaults to zeros for runs that never produced
              tokens (the readout is structural, not conditional on data). */}
          {(() => {
            const liveUsage = run.token_usage as {
              input_tokens?: number;
              output_tokens?: number;
            } | null;
            const totalTokens = (liveUsage?.input_tokens ?? 0) + (liveUsage?.output_tokens ?? 0);
            return (
              <div className="text-muted-foreground bg-muted/50 flex items-center gap-2 rounded-md px-2.5 py-1 text-xs tabular-nums">
                {isRunning && (
                  <span className="bg-primary size-1.5 animate-pulse rounded-full" aria-hidden />
                )}
                <span>{totalTokens.toLocaleString()} tokens</span>
                <span aria-hidden>·</span>
                <span className="text-foreground font-medium">${(run.cost ?? 0).toFixed(4)}</span>
              </div>
            );
          })()}
          {!isRunning && !isInline && agent && (
            <Button variant="outline" size="sm" onClick={() => setInputOpen(true)}>
              <Play className="size-3.5" />
              {t("run.rerun")}
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

      {activeTab === "result" && hasOutput && <JsonView data={finalOutput} />}

      {activeTab === "logs" && <LogViewer entries={allLogs} />}

      {activeTab === "memory" && <MemoryPanel packageId={packageId} runId={runId} />}

      {activeTab === "documents" && runId && <RunDocumentsTab runId={runId} />}

      {activeTab === "info" && <RunInfoTab run={enrichedRun} />}
    </div>
  );
}
