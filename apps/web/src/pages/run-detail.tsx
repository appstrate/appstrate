// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useMemo, useEffect } from "react";
import { useParams, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@appstrate/ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { usePackageDetail } from "../hooks/use-packages";
import { useRun, useRunLogs } from "../hooks/use-runs";
import { useRunAgent, useCancelRun } from "../hooks/use-mutations";
import { Spinner } from "../components/spinner";
import { useRunRealtime, type RunMetricEvent, type RunLogEvent } from "../hooks/use-realtime";
import { useCurrentOrgId } from "../hooks/use-org";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { LogViewer } from "../components/log-viewer";
import { buildLogEntries, buildTurnRows } from "../components/log-utils";
import { RunModal } from "../components/run-modal";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState } from "../components/page-states";
import { RunInfoTab } from "../components/run-info-tab";
import { RunDocumentsTab } from "../components/run-documents-tab";
import { RunDetailTabsController } from "../components/run-detail-tabs-controller";
import { invalidateOrgStorage } from "../hooks/use-documents";
import { RunRow } from "../components/run-row";
import { RunCostReadout } from "../components/run-cost-readout";
import { ContextGaugeReadout } from "../components/run-context-gauge";
import { RunDegradedBanner } from "../components/run-degraded-banner";
import { RunArtifactsBanner } from "../components/run-artifacts-banner";
import { useMarkReadByRun } from "../hooks/use-notifications";
import { ACTIVE_RUN_STATUSES, type EnrichedRun } from "@appstrate/shared-types";
import type { components } from "../api/client";
import { formatDateField } from "../lib/format-date";
import { JsonView } from "../components/json-view";
import { useRunMemories, useRunPinned } from "../hooks/use-persistence";
import { runKeys, invalidateRunLogs } from "../lib/query-keys";
import { inlineRunDisplayName, runPageTitle } from "../lib/run-title";
import { MemoryPanel } from "../components/persistence/memory-panel";
import { Play } from "lucide-react";
import type { RunDetailTab } from "../lib/run-detail-tabs";

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

  // Document count for the tab badge — read off the run DTO the page already
  // has (same field `run-row.tsx` renders). Listing the run's documents just to
  // count them cost a request on every run page and silently saturated at the
  // page size; the list query now runs only when the tab is actually opened.
  const inputDocumentCount = run?.document_counts.input ?? 0;
  const outputDocumentCount = run?.document_counts.output ?? 0;
  const documentCount = inputDocumentCount + outputDocumentCount;
  // The derived presentation rule (#1177): a run that PRODUCED exactly one file
  // leads with the tab that shows it. Inputs the run consumed never count, and
  // nothing the agent declared takes part — the count is the whole rule.
  const hasFeaturedDocument = outputDocumentCount === 1;

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
    { label: t("nav.orgSection", { ns: "common" }), href: "/" },
    { label: t("detail.breadcrumb"), href: "/agents" },
    agentCrumb,
    ...(isInline ? [] : [{ label: runCrumbLabel }]),
  ];

  return (
    <div className="p-6">
      <PageHeader title={title} breadcrumbs={breadcrumbs} />

      <div className="border-border mb-4 rounded-md border">
        <RunRow run={enrichedRun} variant="detail" />
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

      <RunArtifactsBanner artifacts={run.artifacts} />

      <RunDetailTabsController
        key={runId}
        availability={{ hasFeaturedDocument, hasResult: hasOutput, hasMemory: hasRunMemory }}
      >
        {({ activeTab, setActiveTab }) => (
          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as RunDetailTab)}>
            {/* `flex-wrap`, not a fixed row: at 375px the tab list alone eats most of
                the width, and the actions group (cost pill, context gauge, Re-run /
                Cancel) cannot fit beside it. The tabs themselves scroll inside
                their bounded region rather than widening the page. */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
              <div className="max-w-full min-w-0 overflow-x-auto pb-1">
                <TabsList className="w-max">
                  {hasOutput && <TabsTrigger value="result">{t("run.tabResultGroup")}</TabsTrigger>}
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
              </div>
              <div className="flex items-center gap-2">
                {/* Cost readout — shown at all times (pending, running, terminal).
              While the run is active the pulse dot animates and `onMetric` SSE
              patches `run.cost` in place at the throttled 250 ms cadence; once
              finalized, the field holds the authoritative aggregate written by
              `finalizeRun`. Structural, not conditional on data. The token
              count that used to sit beside it moved into the run row's details
              panel (#1046): it is a diagnostic, read once, where the `$` is a
              governance figure read at a glance. */}
                <div className="text-muted-foreground bg-muted/50 flex items-center gap-2 rounded-md px-2.5 py-1 text-xs tabular-nums">
                  {isRunning && (
                    <span className="bg-primary size-1.5 animate-pulse rounded-full" aria-hidden />
                  )}
                  <RunCostReadout
                    cost={run.cost}
                    pricingStatus={run.cost_pricing_status}
                    className="text-foreground font-medium"
                  />
                </div>
                {/* Context gauge — the state metric the cumulative token total never
              was (#1046). Numerator AND denominator both ride `turnRows`, so
              nothing is threaded from the run DTO; see `ContextGaugeReadout`
              for the readings, the live cadence and when it renders nothing. */}
                <ContextGaugeReadout turns={turnRows} status={run.status} />
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

            {hasOutput && (
              <TabsContent value="result" className="mt-0">
                <JsonView data={finalOutput} />
              </TabsContent>
            )}

            <TabsContent value="logs" className="mt-0">
              <LogViewer entries={allLogs} />
            </TabsContent>

            {hasRunMemory && (
              <TabsContent value="memory" className="mt-0">
                <MemoryPanel packageId={packageId} runId={runId} />
              </TabsContent>
            )}

            <TabsContent value="documents" className="mt-0">
              {runId && <RunDocumentsTab runId={runId} />}
            </TabsContent>

            <TabsContent value="info" className="mt-0">
              <RunInfoTab run={enrichedRun} turns={turnRows} />
            </TabsContent>
          </Tabs>
        )}
      </RunDetailTabsController>
    </div>
  );
}
