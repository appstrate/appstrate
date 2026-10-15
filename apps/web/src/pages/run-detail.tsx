// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useEffect } from "react";
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
import { useModalParam } from "../hooks/use-modal-param";
import { RunLaunchRecovery } from "../components/run-launch-recovery";
import { PageHeader } from "../components/page-header";
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
import { ArrowRight } from "lucide-react";
import {
  DetailTabs,
  DetailTabBar,
  DetailTabPanel,
  type DetailTab,
} from "../components/detail-tabs";
import { RunStatusBadge } from "../components/status-badge";
import { RunProvenanceBadges } from "../components/run-cells";
import type { JournalOverviewFilter } from "../components/log-viewer";
import { isQueryInFlight } from "../lib/query-state";
import { findModelFallback } from "../lib/run-model-fallback";

/** Wire shape of a persisted log row (spec `RunLog`); `createdAt` is an ISO string. */
type RunLogEntry = components["schemas"]["RunLog"];

const RUN_DETAIL_TABS = ["overview", "journal", "results"] as const;
type RunDetailTab = (typeof RUN_DETAIL_TABS)[number];

export function RunDetailPage() {
  const { t } = useTranslation(["agents", "common"]);
  const { scope, name, runId } = useParams<{ scope: string; name: string; runId: string }>();
  const packageId = `${scope}/${name}`;
  // Inline shadow packages are filtered from catalog endpoints: fetching would 404.
  const isInlinePath = packageId.startsWith("@inline/");
  const location = useLocation();
  const navigate = useNavigate();
  const stateNumber = (location.state as { runNumber?: number } | null)?.runNumber;
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const { can, ready: permissionsReady } = usePermissions();
  const canReadAgent = can("agents:read");
  // A run does not prove the agent is still active: "Relancer" answers to the
  // same gate as the Run button (`AgentDetail.active`), so Re-run renders only
  // once this has landed.
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

  // `useGlobalRunSync` patches `run.status` into the cache, so no local mirror.
  const status = run?.status;
  const isRunning = !!status && (ACTIVE_RUN_STATUSES as ReadonlySet<string>).has(status);
  const isTerminal = !!status && !isRunning;

  const logsQuery = useRunLogs(runId);
  const { data: logs } = logsQuery;

  const qc = useQueryClient();

  const markRead = useMarkReadByRun();

  // On a terminal status (also when it flips while open): mark the notification
  // read (idempotent server-side) and refetch the logs (separate from the global
  // invalidation, see `invalidateRunLogs`). Cannot loop: deps never include the logs.
  useEffect(() => {
    const terminal = !!status && !(ACTIVE_RUN_STATUSES as ReadonlySet<string>).has(status);
    if (run && runId && terminal) {
      markRead.mutate({ params: { path: { runId } } });
      void invalidateRunLogs(qc, orgId, spaceId, runId);
    }
  }, [status, runId]); // eslint-disable-line react-hooks/exhaustive-deps

  const launcher = useRunLauncher(packageId);
  const cancelRun = useCancelRun();
  const rerun = useModalParam("rerun");
  const { historicalLogs, structuredOutput, turnRows } = useMemo(() => {
    if (!logs) {
      return { historicalLogs: [], structuredOutput: null, turnRows: [] };
    }
    const { entries, output } = buildLogEntries(logs, { isRunTerminal: isTerminal });
    // Turn breadcrumbs are filtered out of the log stream and projected into the per-turn table.
    return { historicalLogs: entries, structuredOutput: output, turnRows: buildTurnRows(logs) };
  }, [logs, isTerminal]);

  // `EnrichedRun.result` is `unknown`; narrow to the OpenAPI shape. `output` is
  // agent-declared (`unknown` in the spec) and needs its own narrowing.
  const execResult = run?.result as components["schemas"]["Run"]["result"];
  const finalOutput =
    structuredOutput || (execResult?.output as Record<string, unknown> | undefined) || null;
  const hasOutput = !!finalOutput && Object.keys(finalOutput).length > 0;
  const allLogs = historicalLogs;
  const modelFallback = useMemo(() => findModelFallback(logs), [logs]);
  const { data: runMemories, isLoading: memoriesLoading } = useRunMemories(packageId, runId);
  const { data: runPinned, isLoading: pinnedLoading } = useRunPinned(packageId, runId);
  const memoryLoading = memoriesLoading || pinnedLoading;
  const runMemoryCount = (runMemories?.length ?? 0) + (runPinned?.length ?? 0);
  const hasRunMemory = runMemoryCount > 0;
  const hasDurableResults = hasOutput || (run?.file_counts.output ?? 0) > 0 || hasRunMemory;

  // Per-run SSE for log inserts and live metrics; status patches come from `useGlobalRunSync`.
  useRunRealtime(isRunning ? runId : null, {
    onNewLog: useCallback(
      (newLog: RunLogEvent) => {
        // Typed as the wire `RunLog` so this writer and `useRunLogs` agree on the
        // shared cache. The `data` cast bridges a generated-type mismatch (the spec
        // declares a bare object, emitted as `Record<string, never> | null`);
        // payloads are populated because the stream opens with `verbose=true`.
        const entry: RunLogEntry = {
          ...newLog,
          data: (newLog.data ?? null) as RunLogEntry["data"],
        };
        qc.setQueryData<RunLogEntry[]>(runKeys.logs(orgId, spaceId, runId), (prev) => {
          if (!prev) return [entry];
          if (prev.some((l) => l.id === entry.id)) return prev;
          return [...prev, entry];
        });
        // A published file arrives as a result log frame (no dedicated SSE
        // channel): refresh the files list, the run (`file_counts` badge) and the org storage total.
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
        // Live usage for the Usage card; mid-run `cost` is the broadcaster's
        // `cost_so_far`, replaced by the canonical row at the terminal refetch.
        // The provenance is patched WITH the number: a live `cost` beside a stale
        // status shows a confident $0.0000 for a run nothing could price.
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
  // `?rerun=1` opens the form only where the Re-run button itself would.
  const rerunOpen = rerun.value !== null && canRerun && !rerunRefusal;
  const hasInlineName = !!enrichedRun.agent_name?.trim();
  const inlineName = inlineRunDisplayName(enrichedRun.agent_name, t("runs.inlineBadge"));

  const agentCrumb = isInline
    ? {
        label: hasInlineName
          ? `${inlineName} (${t("runs.inlineBadge").toLowerCase()})`
          : inlineName,
        href: location.pathname,
      }
    : {
        // The list's name stands in while the detail loads; the id only for a nameless agent.
        label: agent?.display_name || knownAgentName || packageId,
        href: `/agents/${packageId}`,
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
    { value: "overview", label: t("run.tabOverview") },
    { value: "journal", label: t("run.tabJournal") },
    { value: "results", label: t("run.tabResults") },
  ];

  const breadcrumbs = [
    { label: t("detail.breadcrumb"), href: "/agents" },
    agentCrumb,
    ...(isInline
      ? []
      : [
          { label: t("detail.tabRuns"), href: `/agents/${packageId}#runs` },
          { label: runCrumbLabel, href: location.pathname },
        ]),
    { label: tabs.find((item) => item.value === tab)?.label ?? tab },
  ];

  return (
    <div>
      <PageHeader
        title={title}
        titleClassName="text-xl"
        breadcrumbs={breadcrumbs}
        wrapActions
        actions={
          <>
            {/* No unread dot here: this page is the reading. */}
            <RunStatusBadge status={enrichedRun.status} />
            <RunProvenanceBadges run={enrichedRun} />
            <RunHeaderActions
              canRerun={canRerun}
              rerunRefusal={rerunRefusal ? t(rerunRefusal) : null}
              // Hidden for remote-origin runs: the process runs on the caller's
              // host and the platform cannot signal it.
              canCancel={isRunning && enrichedRun.runOrigin !== "remote" && can("runs:cancel")}
              rerunPending={launcher.isPending}
              cancelPending={cancelRun.isPending}
              onRerun={() => {
                if (canReadAgent) rerun.open();
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
          </>
        }
      >
        <RunHeaderSummary run={enrichedRun} />
      </PageHeader>

      {agent && canReadAgent && (
        <RunModal
          open={rerunOpen}
          onClose={rerun.close}
          agent={agent}
          onSubmit={(input) => {
            // Re-run the SAME definition as far as this caller may (only an author replays a draft).
            launcher.launch(
              { input, version: replayVersion(run.version_ref, agent.home_writable) },
              { leave: rerun.leave },
            );
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

      <DetailTabs value={tab} onChange={setTab}>
        <div className="overflow-visible" data-run-detail-surface>
          <DetailTabBar tabs={tabs} />

          <DetailTabPanel value="overview">
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
    </div>
  );
}
