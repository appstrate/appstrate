// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useEffect, useState } from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { usePackageDetail } from "../hooks/use-packages";
import { agentLaunchRefusal } from "../hooks/use-agent-readiness";
import { useRun, useRunLogs } from "../hooks/use-runs";
import { useRunLauncher, useCancelRun } from "../hooks/use-mutations";
import { useRunRealtime, type RunMetricEvent, type RunLogEvent } from "../hooks/use-realtime";
import { useCurrentOrgId } from "../hooks/use-org";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { usePermissions } from "../hooks/use-permissions";
import { buildLogEntries, buildTurnRows } from "../components/log-utils";
import { RunModal } from "../components/run-modal";
import { RunLaunchRecovery } from "../components/run-launch-recovery";
import { DetailBar } from "../components/detail-bar";
import { ResourceErrorState } from "../components/page-states";
import { RunDetailSkeleton } from "../components/loading-skeletons";
import { useMarkReadByRun } from "../hooks/use-notifications";
import { ACTIVE_RUN_STATUSES, type AgentListItem, type EnrichedRun } from "@appstrate/shared-types";
import type { components } from "../api/client";
import { formatDateField } from "../lib/format-date";
import { isPublishedFileLogEvent } from "../lib/files";
import { searchOf } from "../lib/url-search";
import { replayVersion } from "../lib/version-selector";
import { useRunMemories, useRunPinned } from "../hooks/use-persistence";
import {
  agentsKeys,
  runKeys,
  invalidateOrgDetail,
  invalidatePaths,
  invalidateRunLogs,
} from "../lib/query-keys";
import { inlineRunDisplayName, runPageTitle } from "../lib/run-title";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { RunHeaderActions, RunHeaderSummary } from "../components/run-detail/run-header-summary";
import { RunExecutionView } from "../components/run-detail/run-execution-view";
import { RunResultsView } from "../components/run-detail/run-results-view";
import { RunSnapshotInspector } from "../components/run-detail/run-snapshot-inspector";
import { Button } from "@appstrate/ui/components/button";
import { ArrowRight, LayoutGrid, FileText, ScrollText } from "lucide-react";
import { DetailTabs, DetailTabPanel, type DetailTab } from "../components/detail-tabs";
import { RunStatusBadge } from "../components/status-badge";
import { RunProvenanceBadges } from "../components/run-cells";
import type { JournalOverviewFilter } from "../components/log-viewer";
import { isQueryInFlight } from "../lib/query-state";
import { findModelFallback } from "../lib/run-model-fallback";

/** Wire shape of a persisted log row (spec `RunLog`); `createdAt` is an ISO string. */
type RunLogEntry = components["schemas"]["RunLog"];

const RUN_DETAIL_TABS = ["overview", "journal", "results"] as const;
type RunDetailTab = (typeof RUN_DETAIL_TABS)[number];

/** One body per run: a re-run leaves for another run, and the form it came from must not follow it. */
export function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  return <RunDetailBody key={runId} />;
}

function RunDetailBody() {
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
  const spaceId = useCurrentSpaceId();
  const { can, ready: permissionsReady } = usePermissions();
  const canReadAgent = can("agents:read");
  // A run PROVES the agent was active here once; it does not prove it still is.
  // Deactivating is an ordinary, reversible gesture now, so "Relancer" answers
  // to the same gate as the detail page's Run button and the card's launcher —
  // said before the click rather than collected as a 404 after it. The verdict
  // rides this very response (`AgentDetail.active`), resolved for the space the
  // page is read from; the Re-run control renders only once it has landed.
  const { data: agent } = usePackageDetail("agent", isInlinePath ? undefined : packageId);
  const runQuery = useRun(runId);
  const [tab, setTab] = useTabWithHash(RUN_DETAIL_TABS, "overview");
  const { data: run, error } = runQuery;
  const runNumber = run?.runNumber ?? stateNumber;
  const requestedJournalFilter = new URLSearchParams(location.search).get("journalFilter");
  const journalFilter: JournalOverviewFilter | undefined =
    requestedJournalFilter === "tools" ||
    requestedJournalFilter === "warnings" ||
    requestedJournalFilter === "errors"
      ? requestedJournalFilter
      : undefined;
  // A tab of this run, the journal on `filter`; the rest of the query stays.
  const openTab = (hash: "#journal" | "#results", filter?: JournalOverviewFilter) => {
    const search = new URLSearchParams(location.search);
    if (filter) search.set("journalFilter", filter);
    else search.delete("journalFilter");
    navigate({ pathname: location.pathname, search: searchOf(search), hash });
  };

  // `useGlobalRunSync` (mounted in MainLayout) patches `run.status` directly
  // into the React Query cache from the LISTEN/NOTIFY stream, so reading
  // `run?.status` is sufficient — no local mirror needed.
  const status = run?.status;
  const isRunning = !!status && (ACTIVE_RUN_STATUSES as ReadonlySet<string>).has(status);
  const isTerminal = !!status && !isRunning;

  const logsQuery = useRunLogs(runId);
  const { data: logs } = logsQuery;

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
      void invalidateRunLogs(qc, orgId, spaceId, runId);
    }
  }, [status, runId]); // eslint-disable-line react-hooks/exhaustive-deps

  const launcher = useRunLauncher(packageId);
  const cancelRun = useCancelRun();
  const [rerunRequested, setRerunRequested] = useState(false);
  const { historicalLogs, structuredOutput, turnRows } = useMemo(() => {
    if (!logs) {
      return { historicalLogs: [], structuredOutput: null, turnRows: [] };
    }
    const { entries, output } = buildLogEntries(logs, { isRunTerminal: isTerminal });
    // Turn breadcrumbs are filtered OUT of the log stream by `buildLogEntries`
    // and projected here into the per-turn table instead (`TurnsTable` in
    // `run-detail/run-turns-detail.tsx`, opened from the overview's Usage card).
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
  const modelFallback = useMemo(() => findModelFallback(logs), [logs]);
  // Run-level memory rows (only those touched during this run).
  const { data: runMemories, isLoading: memoriesLoading } = useRunMemories(packageId, runId);
  const { data: runPinned, isLoading: pinnedLoading } = useRunPinned(packageId, runId);
  const memoryLoading = memoriesLoading || pinnedLoading;
  const runMemoryCount = (runMemories?.length ?? 0) + (runPinned?.length ?? 0);
  const hasRunMemory = runMemoryCount > 0;
  const hasDurableResults = hasOutput || (run?.file_counts.output ?? 0) > 0 || hasRunMemory;

  // Per-run SSE for log inserts + live metric updates. Status patches
  // come from `useGlobalRunSync` (mounted in MainLayout), which writes
  // directly into the same `["run", orgId, spaceId, runId]`
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
        qc.setQueryData<RunLogEntry[]>(runKeys.logs(orgId, spaceId, runId), (prev) => {
          if (!prev) return [entry];
          if (prev.some((l) => l.id === entry.id)) return prev;
          return [...prev, entry];
        });
        // A published file arrives as a `type='result' event='file'`
        // log frame — invalidate the run's files list (the tab body), the
        // run itself (its `file_counts` drives the tab badge) and the org
        // storage total those new bytes just moved, without a dedicated SSE
        // channel. `isPublishedFileLogEvent` tests membership of the set the
        // sink's own tag is built from — it carries no legacy spelling.
        if (entry.type === "result" && isPublishedFileLogEvent(entry.event)) {
          void invalidatePaths(qc, ["/api/files"]);
          void qc.invalidateQueries({ queryKey: runKeys.detail(orgId, spaceId, runId) });
          void invalidateOrgDetail(qc);
        }
      },
      [qc, orgId, spaceId, runId],
    ),
    onMetric: useCallback(
      (metric: RunMetricEvent) => {
        // Patch the cached run row with the running token usage + cost
        // so the overview's Usage card (`run-snapshot-inspector.tsx`)
        // reflects live progress without polling.
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
        qc.setQueryData<EnrichedRun>(runKeys.detail(orgId, spaceId, runId), (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            token_usage: metric.tokenUsage ?? prev.token_usage,
            cost: metric.costSoFar,
            cost_pricing_status: metric.costPricingStatus,
          };
        });
      },
      [qc, orgId, spaceId, runId],
    ),
  });

  if (isQueryInFlight(runQuery)) return <RunDetailSkeleton agentName={agent?.display_name} />;

  if (error || !run) return <ResourceErrorState error={error} />;
  const rerunRefusal = agent ? agentLaunchRefusal(agent) : null;

  const enrichedRun = run;
  const knownAgentName = qc
    .getQueryData<AgentListItem[]>(agentsKeys.list(orgId, spaceId))
    ?.find((candidate) => candidate.id === packageId)?.display_name;
  const date = run.started_at ? formatDateField(run.started_at) : "";
  const isInline = enrichedRun.package_ephemeral;
  const canRerun = !isRunning && !isInline && !!agent && permissionsReady && can("agents:run");
  const rerunOpen = rerunRequested && canRerun && !rerunRefusal;
  const inlineName = inlineRunDisplayName(enrichedRun.agent_name, t("runs.inlineBadge"));

  // The list this run belongs to, in the header's small line: its agent's runs,
  // or the runs list for an inline run, which has no agent page.
  const parent = isInline
    ? { label: t("runs.title"), href: "/runs" }
    : {
        // The name the agents list already holds stands in while the detail
        // loads; the id is the fallback for an agent with no name, never a
        // placeholder for one whose name is still on its way.
        label: agent?.display_name || knownAgentName || packageId,
        href: `/agents/${packageId}#runs`,
      };

  const runCrumbLabel = runNumber
    ? t("run.breadcrumb", { number: runNumber })
    : date || runId?.slice(0, 8) || "";
  const title = runPageTitle({
    isInline,
    inlineName,
    numberedTitle: runCrumbLabel,
  });
  const tabs: DetailTab<RunDetailTab>[] = [
    { value: "overview", label: t("run.tabOverview"), icon: LayoutGrid },
    { value: "journal", label: t("run.tabJournal"), icon: ScrollText },
    { value: "results", label: t("run.tabResults"), icon: FileText },
  ];

  return (
    <DetailTabs value={tab} onChange={setTab}>
      <DetailBar
        title={title}
        parent={parent}
        tabs={tabs}
        badge={
          <>
            {/* No unread dot here: this page is the reading. */}
            <RunStatusBadge status={enrichedRun.status} />
            <RunProvenanceBadges run={enrichedRun} />
          </>
        }
        actions={
          <RunHeaderActions
            canRerun={canRerun}
            rerunRefusal={rerunRefusal ? t(rerunRefusal) : null}
            // Hidden for remote-origin runs: the process runs on the caller's
            // host and the platform cannot signal it.
            canCancel={isRunning && enrichedRun.runOrigin !== "remote" && can("runs:cancel")}
            rerunPending={launcher.isPending}
            cancelPending={cancelRun.isPending}
            onRerun={() => {
              if (canReadAgent) setRerunRequested(true);
              // The API conceals resolved input from runners: replay that
              // snapshot server-side, keeping its parameters.
              else
                launcher.launch({
                  rerun_from: run.id,
                  version: replayVersion(run.version_ref, agent?.home_writable),
                });
            }}
            onCancel={() => cancelRun.mutate(runId!)}
          />
        }
      />

      {agent && canReadAgent && (
        <RunModal
          open={rerunOpen}
          onClose={() => setRerunRequested(false)}
          agent={agent}
          onSubmit={(input) => {
            // Re-run the SAME definition the original run executed, as far as
            // this caller may: `version_ref` is "draft" or a concrete semver,
            // and only an author replays a draft (see `replayVersion`).
            launcher.launch({
              input,
              version: replayVersion(run.version_ref, agent.home_writable),
            });
          }}
          isPending={launcher.isPending}
          initialInput={(run.input as Record<string, unknown>) ?? undefined}
        />
      )}

      <RunLaunchRecovery
        launcher={launcher}
        packageId={packageId}
        integrationEntries={agent?.dependencies.integrations}
      />

      <div className="overflow-visible" data-run-detail-surface>
        <DetailTabPanel value="overview">
          <RunHeaderSummary run={enrichedRun} />
          <RunSnapshotInspector
            run={enrichedRun}
            turns={turnRows}
            logs={allLogs}
            structuredOutput={finalOutput}
            memoryChangeCount={runMemoryCount}
            logsLoading={logsQuery.isLoading}
            memoryLoading={memoryLoading}
            modelFallback={modelFallback}
            onOpenJournal={(filter) => openTab("#journal", filter)}
            onOpenResults={() => openTab("#results")}
          />
        </DetailTabPanel>

        <DetailTabPanel value="journal" flush>
          <RunExecutionView
            run={enrichedRun}
            logs={allLogs}
            logsLoading={logsQuery.isLoading}
            initialFilter={journalFilter}
            headerActions={
              run.status === "success" && hasDurableResults ? (
                <Button variant="outline" size="sm" onClick={() => setTab("results")}>
                  {t("run.viewResults")}
                  <ArrowRight className="size-3.5" />
                </Button>
              ) : undefined
            }
          />
        </DetailTabPanel>

        <DetailTabPanel value="results" flush>
          <RunResultsView
            run={enrichedRun}
            packageId={packageId}
            output={finalOutput}
            hasRunMemory={hasRunMemory}
            isRunning={isRunning}
            outputLoading={logsQuery.isLoading}
            memoryLoading={memoryLoading}
          />
        </DetailTabPanel>
      </div>
    </DetailTabs>
  );
}
