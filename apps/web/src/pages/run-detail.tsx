// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useMemo, useEffect } from "react";
import { useParams, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { usePackageDetail } from "../hooks/use-packages";
import { useRun, useRunLogs } from "../hooks/use-runs";
import { useRunAgent, useCancelRun } from "../hooks/use-mutations";
import { useRunRealtime, type RunMetricEvent, type RunLogEvent } from "../hooks/use-realtime";
import { useCurrentOrgId } from "../hooks/use-org";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { buildLogEntries, buildTurnRows } from "../components/log-utils";
import { RunModal } from "../components/run-modal";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState } from "../components/page-states";
import { RunDetailTabsController } from "../components/run-detail-tabs-controller";
import { invalidateOrgStorage } from "../hooks/use-documents";
import { RunDegradedBanner } from "../components/run-degraded-banner";
import { RunArtifactsBanner } from "../components/run-artifacts-banner";
import { useMarkReadByRun } from "../hooks/use-notifications";
import { ACTIVE_RUN_STATUSES, type EnrichedRun } from "@appstrate/shared-types";
import type { components } from "../api/client";
import { formatDateField } from "../lib/markdown";
import { useRunMemories, useRunPinned } from "../hooks/use-persistence";
import { runKeys, invalidateRunLogs } from "../lib/query-keys";
import { inlineRunDisplayName, runPageTitle } from "../lib/run-title";
import type { RunDetailTab } from "../lib/run-detail-tabs";
import { RunHeaderSummary } from "../components/run-detail/run-header-summary";
import { RunExecutionView } from "../components/run-detail/run-execution-view";
import { RunResultsView } from "../components/run-detail/run-results-view";
import { Button } from "@appstrate/ui/components/button";
import { ArrowRight, Check, Clipboard, Play, Settings2 } from "lucide-react";
import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard";

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
  const isTerminal = !!status && !isRunning;

  const { data: logs } = useRunLogs(runId);

  const qc = useQueryClient();

  const markRead = useMarkReadByRun();

  // Auto-mark notification as read when viewing a terminal run, and refetch the
  // run's logs. Keyed on `status`: the SSE run patch carries `status` (see
  // `runUpdateToRunPatch`), so a run that finalizes while the page is open acts
  // the moment status flips terminal. Idempotent server-side (no-op for a
  // non-recipient / already-read), and `status` is stable once terminal so the
  // effect does not re-fire on subsequent renders.
  //
  // Why the log refetch is a separate call rather than a consequence of the
  // global invalidation: see `invalidateRunLogs`. It cannot loop — the effect
  // depends on `status`/`runId`, never on the logs it refetches.
  useEffect(() => {
    const terminal = !!status && !(ACTIVE_RUN_STATUSES as ReadonlySet<string>).has(status);
    if (run && runId && terminal) {
      markRead.mutate({ params: { path: { runId } } });
      void invalidateRunLogs(qc, orgId, applicationId, runId);
    }
  }, [status, runId]); // eslint-disable-line react-hooks/exhaustive-deps

  const runAgent = useRunAgent(packageId);
  const cancelRun = useCancelRun();
  const [inputOpen, setInputOpen] = useState(false);
  const { copied: errorCopied, copy: copyError } = useCopyToClipboard();
  const { historicalLogs, structuredOutput, turnRows } = useMemo(() => {
    if (!logs) {
      return { historicalLogs: [], structuredOutput: null, turnRows: [] };
    }
    const { entries, output } = buildLogEntries(logs, { isRunTerminal: isTerminal });
    // Turn breadcrumbs are filtered OUT of the log stream by `buildLogEntries`
    // and projected here into the Info tab's per-turn table instead.
    return { historicalLogs: entries, structuredOutput: output, turnRows: buildTurnRows(logs) };
  }, [logs, isTerminal]);

  // `EnrichedRun.result` mirrors the jsonb column as `unknown`; the generated
  // OpenAPI schema is the authority on its shape, so narrow to that rather
  // than re-declaring the fields here. `output` is deliberately `unknown` in
  // the spec (agent-declared), so it still needs a local narrowing.
  const execResult = run?.result as components["schemas"]["Run"]["result"];
  const finalOutput =
    structuredOutput || (execResult?.output as Record<string, unknown> | undefined) || null;
  const hasOutput = !!finalOutput && Object.keys(finalOutput).length > 0;
  const allLogs = historicalLogs;
  // Run-level memory rows (only those touched during this run).
  const { data: runMemories } = useRunMemories(packageId, runId);
  const { data: runPinned } = useRunPinned(packageId, runId);
  const runMemoryCount = (runMemories?.length ?? 0) + (runPinned?.length ?? 0);
  const hasRunMemory = runMemoryCount > 0;
  const hasResults =
    hasOutput ||
    (run?.document_counts.output ?? 0) > 0 ||
    hasRunMemory ||
    Boolean(run?.primary_document_id);

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
        // the matching fields (id/createdAt are ISO strings on both).
        //
        // `data` needs a localized narrow, but NOT because the frame is empty:
        // `use-realtime.ts` opens this stream with `verbose=true`, the flag that
        // makes `routes/realtime.ts` send `evt.data` rather than
        // `stripPayload(evt)`, so payloads arrive populated. The cast bridges a
        // generated-type mismatch: the spec declares `data` as a bare object, so
        // `schema.d.ts` emits `Record<string, never> | null`.
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
        // log frame — invalidate the run's documents list (the tab body), the
        // run itself (its `document_counts` drives the tab badge) and the org
        // storage total those new bytes just moved, without a dedicated SSE
        // channel.
        if (entry.type === "result" && entry.event === "document") {
          void qc.invalidateQueries({ queryKey: ["get", "/api/documents"] });
          void qc.invalidateQueries({ queryKey: runKeys.detail(orgId, applicationId, runId) });
          invalidateOrgStorage(qc);
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
        //
        // The provenance is patched WITH the number, never separately: a
        // live `cost` paired with the stale (or absent) status of the
        // previous read is how a run nothing could price ends up showing a
        // confident $0.0000 for its whole duration.
        qc.setQueryData<EnrichedRun>(runKeys.detail(orgId, applicationId, runId), (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            token_usage: metric.tokenUsage ?? prev.token_usage,
            cost: metric.costSoFar,
            cost_pricing_status: metric.costPricingStatus,
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
  const hasInlineName = !!enrichedRun.agent_name?.trim();
  const inlineName = inlineRunDisplayName(enrichedRun.agent_name, t("runs.inlineBadge"));

  // For inline runs the agent crumb *is* the last crumb (the run itself),
  // so omit href — PageHeader renders it as the current-page indicator.
  const agentCrumb = isInline
    ? {
        label: hasInlineName
          ? `${inlineName} (${t("runs.inlineBadge").toLowerCase()})`
          : inlineName,
      }
    : { label: agent?.display_name || packageId || "", href: `/agents/${packageId}` };

  const runCrumbLabel = runNumber
    ? t("run.breadcrumb", { number: runNumber })
    : date || runId?.slice(0, 8) || "";
  const title = runPageTitle({
    isInline,
    inlineName,
    numberedTitle: runCrumbLabel,
  });

  // Inline agents are 1:1 with their single run — the agent crumb already
  // identifies the run, so a trailing "Run #N" crumb is redundant.
  const breadcrumbs = [
    { label: t("detail.breadcrumb"), href: "/agents" },
    agentCrumb,
    ...(isInline ? [] : [{ label: runCrumbLabel }]),
  ];

  return (
    <div>
      <PageHeader title={title} breadcrumbs={breadcrumbs} />

      <RunHeaderSummary
        run={enrichedRun}
        isRunning={isRunning}
        canRerun={!isRunning && run.status !== "failed" && !isInline && !!agent}
        canCancel={isRunning && enrichedRun.runOrigin !== "remote"}
        rerunPending={runAgent.isPending}
        cancelPending={cancelRun.isPending}
        onRerun={() => setInputOpen(true)}
        onCancel={() => cancelRun.mutate(runId!)}
      />

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
        <div className="border-destructive/20 bg-destructive/10 mb-4 rounded-lg border px-4 py-3">
          <p className="text-destructive text-sm font-medium">{t("run.failureTitle")}</p>
          <p className="text-destructive/90 mt-1 text-sm">{run.error}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {agent && !isInline && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={runAgent.isPending}
                  onClick={() =>
                    runAgent.mutate({
                      input: (run.input as Record<string, unknown>) ?? {},
                      version: run.version_ref,
                    })
                  }
                >
                  <Play className="size-3.5" />
                  {t("run.rerun")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={runAgent.isPending}
                  onClick={() => setInputOpen(true)}
                >
                  <Settings2 className="size-3.5" />
                  {t("run.modifyAndRerun")}
                </Button>
              </>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void copyError(
                  JSON.stringify({ runId: run.id, status: run.status, error: run.error }, null, 2),
                )
              }
            >
              {errorCopied ? <Check className="size-3.5" /> : <Clipboard className="size-3.5" />}
              {errorCopied ? t("run.errorCopied") : t("run.copyError")}
            </Button>
          </div>
        </div>
      )}

      <RunDegradedBanner metadata={run.metadata} />

      <RunArtifactsBanner artifacts={run.artifacts} />

      <RunDetailTabsController
        key={runId}
        availability={{
          isActive: isRunning,
          isSuccessful: run.status === "success",
          hasResults,
        }}
      >
        {({ activeTab, setActiveTab }) => (
          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as RunDetailTab)}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <TabsList>
                <TabsTrigger value="execution">{t("run.tabExecution")}</TabsTrigger>
                <TabsTrigger value="results" disabled={isRunning}>
                  {t("run.tabResults")}
                </TabsTrigger>
              </TabsList>
              {isRunning && (
                <p className="text-muted-foreground hidden text-xs sm:block">
                  {t("run.resultsAvailableAfterExecution")}
                </p>
              )}
            </div>

            <TabsContent value="execution" className="mt-0">
              {run.status === "success" && hasResults && (
                <div className="mb-4 flex justify-end">
                  <Button variant="outline" size="sm" onClick={() => setActiveTab("results")}>
                    {t("run.viewResults")}
                    <ArrowRight className="size-3.5" />
                  </Button>
                </div>
              )}
              <RunExecutionView run={enrichedRun} logs={allLogs} turns={turnRows} />
            </TabsContent>

            <TabsContent value="results" className="mt-0">
              <RunResultsView
                run={enrichedRun}
                packageId={packageId}
                output={finalOutput}
                hasRunMemory={hasRunMemory}
              />
            </TabsContent>
          </Tabs>
        )}
      </RunDetailTabsController>
    </div>
  );
}
