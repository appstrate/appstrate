// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Activity,
  ChartNoAxesCombined,
  CirclePlay,
  Code2,
  FileInput,
  Link2,
  Tags,
  Trophy,
} from "lucide-react";
import { ACTIVE_RUN_STATUSES, type EnrichedRun } from "@appstrate/shared-types";
import { FILE_URI_PREFIX } from "@appstrate/core/file-uri";
import { RunTurnsDetail } from "./run-turns-detail";
import { journalLevel, type RunTurnRow } from "../log-utils";
import { RunCostReadout } from "../run-cost-readout";
import { Modal } from "../modal";
import { useFiles, type FileDto } from "../../hooks/use-files";
import { usePermissions } from "../../hooks/use-permissions";
import { DocumentListPanel } from "../document-list-panel";
import { JsonView } from "../json-view";
import { runFileDirection } from "../../lib/files";
import { formatDateField } from "../../lib/format-date";
import { runConnectionRows } from "../../lib/run-connections";
import { runErrorText } from "../../lib/run-error";
import { getRunTriggerActor, getRunTriggerType } from "../../lib/run-trigger";
import type { ExecutionEntry } from "../log-utils";
import { OverviewCardAction } from "../overview-card-action";
import type { JournalOverviewFilter } from "../log-viewer";
import { RunDuration } from "../run-duration";
import { DetailSectionCard } from "../detail-section-card";
import { HealthAction, HealthCard, HealthCardItem } from "../health-card";
import { useModalParam } from "../../hooks/use-modal-param";
import type { RunModelFallback } from "../../lib/run-model-fallback";
import { RunWarnings } from "./run-warnings";
import { formatNumber } from "../../lib/format-number";
import { scheduleDetailPath } from "../../lib/package-paths";
import { readRunContext } from "../run-context";
import { ContextGaugeReadout } from "./run-context-gauge";
import { Fact, FactGrid } from "@appstrate/ui/components/fact-grid";
import { OperationalStat } from "../operational-stat";

export function RunSnapshotInspector({
  run,
  turns,
  logs,
  structuredOutput,
  logsLoading,
  memoryChangeCount,
  memoryLoading,
  modelFallback,
  onOpenJournal,
  onOpenResults,
}: {
  run: EnrichedRun;
  turns: RunTurnRow[];
  logs: ExecutionEntry[];
  structuredOutput: Record<string, unknown> | null;
  /** The journal is still being read: what is counted from it is not known yet. */
  logsLoading: boolean;
  memoryChangeCount: number;
  /** The run's memory rows are still being read. */
  memoryLoading: boolean;
  /** The `model_fallback` marker of the run's journal, when it has one. */
  modelFallback: RunModelFallback | null;
  onOpenJournal: (filter?: JournalOverviewFilter) => void;
  onOpenResults: () => void;
}) {
  const { t } = useTranslation("agents");
  const turnsParam = useModalParam("turns");
  // The run's whole file container (the query the Results tab reads too): its
  // inputs are what it consumed, uploads and files chained in from earlier runs.
  const filesQuery = useFiles({ runId: run.id, limit: 100 });
  const filesDenied = !usePermissions().can("files:read");
  const metadata = (run.metadata as Record<string, unknown> | null) ?? null;
  const usage = run.token_usage;
  // One fact per integration, listing every connection it bound, and one per
  // declared integration the run started without.
  const connections = runConnectionRows(run);
  const agentExecuted =
    [run.agent_scope, run.agent_name].filter(Boolean).join("/") || t("run.unknownValue");
  const triggerActor = getRunTriggerActor(run);
  const runnerLabel =
    run.runner_name ??
    (run.runOrigin === "remote" ? t("run.infoRunnerRemote") : t("run.infoRunnerPlatform"));
  const toolCallCount = logs.filter((entry) => entry.kind === "tool").length;
  // Counted by the journal's own levels: each count opens its filter there.
  const warningCount = logs.filter((entry) => journalLevel(entry) === "warn").length;
  const errorCount = logs.filter((entry) => journalLevel(entry) === "error").length;
  const structuredFieldCount = Object.keys(structuredOutput ?? {}).length;
  // What ended the run, and what it lost on the way (`RunWarnings`), is part of
  // its story, so it is told here, not in a banner over every tab: a failure or a timeout opens the overview as its
  // problem card (the agent page's Diagnostic card); a cancellation is no
  // problem, so it opens the overview as a neutral card of its own.
  const problem = run.error && (run.status === "failed" || run.status === "timeout");
  const cancelled = run.status === "cancelled";
  const statSkeleton = <Skeleton className="h-6 w-10" />;

  return (
    <>
      <div data-run-snapshot>
        {problem && (
          <div className="mb-6">
            <HealthCard title={t("run.overview.problem")} tone="blocking" badge={null}>
              <ul className="px-4">
                <HealthCardItem
                  title={runErrorText(run, t)}
                  actions={
                    <HealthAction onClick={() => onOpenJournal("errors")}>
                      {t("run.overview.problemJournal")}
                    </HealthAction>
                  }
                />
              </ul>
            </HealthCard>
          </div>
        )}
        {cancelled && (
          <div className="mb-6">
            <HealthCard title={t("run.overview.cancelled")} tone="neutral" badge={null}>
              <ul className="px-4">
                {/* The run keeps no name for who stopped it: the platform's reason and the time do. */}
                <HealthCardItem
                  title={run.error ? runErrorText(run, t) : t("run.cancelledByUser")}
                  description={
                    run.completed_at ? formatDateField(run.completed_at, "datetime") : undefined
                  }
                  actions={null}
                />
              </ul>
            </HealthCard>
          </div>
        )}
        <RunWarnings run={run} modelFallback={modelFallback} />
        <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]">
          <div className="grid min-w-0 content-start gap-6 lg:grid-cols-2">
            <DetailSectionCard
              title={t("run.infoExecution")}
              icon={CirclePlay}
              className="lg:col-span-2"
            >
              <FactGrid columns={4}>
                <Fact label={t("run.sourceAgent")}>{agentExecuted}</Fact>
                {!run.package_ephemeral && (
                  <Fact label={t("run.infoVersion")}>{versionText(run, t)}</Fact>
                )}
                <Fact label={t("run.infoTriggerType")}>
                  {t(`run.triggerType.${getRunTriggerType(run)}`)}
                </Fact>
                {run.scheduleId && (
                  <Fact label={t("run.triggerType.schedule")}>
                    <Link
                      className="text-primary hover:underline"
                      to={scheduleDetailPath(run.scheduleId)}
                    >
                      {run.schedule_name || t("schedule.unnamed")}
                    </Link>
                  </Fact>
                )}
                {triggerActor && <Fact label={t("run.infoTriggeredBy")}>{triggerActor}</Fact>}
                <Fact label={t("run.infoRunner")}>{runnerLabel}</Fact>
                {run.started_at && (
                  <Fact label={t("run.infoStartedAt")}>
                    {formatDateField(run.started_at, "datetime")}
                  </Fact>
                )}
                {run.completed_at && (
                  <Fact label={t("run.infoCompletedAt")}>
                    {formatDateField(run.completed_at, "datetime")}
                  </Fact>
                )}
                {(run.duration != null || run.started_at) && (
                  <Fact label={t("run.infoDuration")}>
                    <RunDuration
                      status={run.status}
                      startedAt={run.started_at}
                      duration={run.duration}
                      className="text-foreground font-sans text-sm"
                    />
                  </Fact>
                )}
                {run.proxy_label && <Fact label={t("run.infoProxy")}>{run.proxy_label}</Fact>}
                <Fact label={t("run.infoRunId")}>
                  <span className="font-mono break-all">{run.id}</span>
                </Fact>
              </FactGrid>
            </DetailSectionCard>

            <DetailSectionCard
              title={t("run.overview.activity")}
              icon={Activity}
              bodyClassName="p-0"
              headerAction={
                logs.length > 0
                  ? {
                      label: t("run.overview.openJournal"),
                      onClick: () => onOpenJournal(),
                    }
                  : undefined
              }
            >
              <dl className="grid grid-cols-2">
                <OperationalStat
                  className="border-border border-r border-b"
                  label={t("run.overview.logEvents")}
                  value={logsLoading ? statSkeleton : formatNumber(logs.length)}
                  target={logs.length > 0 ? { onClick: () => onOpenJournal() } : undefined}
                />
                <OperationalStat
                  className="border-border border-b"
                  label={t("run.overview.toolCalls")}
                  value={logsLoading ? statSkeleton : formatNumber(toolCallCount)}
                  target={toolCallCount > 0 ? { onClick: () => onOpenJournal("tools") } : undefined}
                />
                <OperationalStat
                  className="border-border border-r"
                  label={t("run.overview.warnings")}
                  value={logsLoading ? statSkeleton : formatNumber(warningCount)}
                  target={
                    warningCount > 0 ? { onClick: () => onOpenJournal("warnings") } : undefined
                  }
                />
                <OperationalStat
                  label={t("run.overview.errors")}
                  value={logsLoading ? statSkeleton : formatNumber(errorCount)}
                  target={errorCount > 0 ? { onClick: () => onOpenJournal("errors") } : undefined}
                />
              </dl>
            </DetailSectionCard>

            <DetailSectionCard
              title={t("run.overview.results")}
              icon={Trophy}
              bodyClassName="p-0"
              headerAction={
                run.file_counts.output + structuredFieldCount + memoryChangeCount > 0
                  ? {
                      label: t("run.overview.openResults"),
                      onClick: onOpenResults,
                    }
                  : undefined
              }
            >
              <dl className="grid grid-cols-2">
                <OperationalStat
                  className="border-border border-r border-b"
                  label={t("run.overview.outputFiles")}
                  value={formatNumber(run.file_counts.output)}
                  target={run.file_counts.output > 0 ? { onClick: onOpenResults } : undefined}
                />
                <OperationalStat
                  className="border-border border-b"
                  label={t("run.overview.structuredFields")}
                  value={logsLoading ? statSkeleton : formatNumber(structuredFieldCount)}
                  target={structuredFieldCount > 0 ? { onClick: onOpenResults } : undefined}
                />
                <OperationalStat
                  className="col-span-2"
                  label={t("run.overview.memoryChanges")}
                  value={memoryLoading ? statSkeleton : formatNumber(memoryChangeCount)}
                  target={memoryChangeCount > 0 ? { onClick: onOpenResults } : undefined}
                />
              </dl>
            </DetailSectionCard>
          </div>

          <div className="grid min-w-0 content-start gap-6">
            <DetailSectionCard
              title={t("run.infoUsage")}
              icon={ChartNoAxesCombined}
              bodyClassName="flex flex-col p-0"
            >
              <div className="flex-1 p-4">
                {/* Live metrics patch the totals until the run settles. */}
                {(ACTIVE_RUN_STATUSES as ReadonlySet<string>).has(run.status) && (
                  <p className="bg-primary/15 text-primary mb-3 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase">
                    <span className="bg-primary size-1.5 animate-pulse rounded-full" aria-hidden />
                    {t("run.usageLive")}
                  </p>
                )}
                <FactGrid columns={2}>
                  {(run.cost != null || run.cost_pricing_status != null) && (
                    <Fact label={t("run.usageEstimatedApiCost")}>
                      <RunCostReadout cost={run.cost} pricingStatus={run.cost_pricing_status} />
                    </Fact>
                  )}
                  {run.model_label && <Fact label={t("run.usageModel")}>{run.model_label}</Fact>}
                  {usage?.input_tokens != null && (
                    <Fact label={t("run.usageInputTokens")}>
                      {formatNumber(usage.input_tokens)}
                    </Fact>
                  )}
                  {usage?.output_tokens != null && (
                    <Fact label={t("run.usageOutputTokens")}>
                      {formatNumber(usage.output_tokens)}
                    </Fact>
                  )}
                  {usage?.cache_creation_input_tokens != null && (
                    <Fact label={t("run.usageCacheCreation")}>
                      {formatNumber(usage.cache_creation_input_tokens)}
                    </Fact>
                  )}
                  {usage?.cache_read_input_tokens != null && (
                    <Fact label={t("run.usageCacheRead")}>
                      {formatNumber(usage.cache_read_input_tokens)}
                    </Fact>
                  )}
                  {logsLoading ? (
                    <Fact label={t("run.usageContext")}>
                      <Skeleton className="h-4 w-24" />
                    </Fact>
                  ) : (
                    readRunContext(turns) && (
                      <Fact label={t("run.usageContext")}>
                        <ContextGaugeReadout turns={turns} status={run.status} />
                      </Fact>
                    )
                  )}
                </FactGrid>
              </div>
              {logsLoading ? (
                <div className="flex min-h-9 w-full items-center border-t px-4 py-2">
                  <Skeleton className="h-4 w-32" />
                </div>
              ) : (
                turns.length > 0 && (
                  <OverviewCardAction target={{ onClick: () => turnsParam.open() }}>
                    {t("run.viewTurnDetails")}
                  </OverviewCardAction>
                )
              )}
            </DetailSectionCard>

            <DetailSectionCard title={t("run.infoInput")} icon={FileInput}>
              <RunInputFacts
                run={run}
                files={filesQuery.data?.data ?? []}
                hasMore={filesQuery.data?.hasMore ?? false}
                isLoading={filesQuery.isLoading}
                error={filesQuery.error}
                filesDenied={filesDenied}
              />
            </DetailSectionCard>

            {connections.length > 0 && (
              <DetailSectionCard title={t("run.infoConnections")} icon={Link2}>
                <FactGrid columns={1}>
                  {connections.map(({ integrationId, bound, unboundCause }) => (
                    <Fact key={integrationId} label={integrationId}>
                      {unboundCause !== null ? (
                        <span
                          className="flex flex-col"
                          data-testid={`run-integration-unbound-${integrationId}`}
                        >
                          <span className="text-muted-foreground">
                            {t("run.integrationUnbound")}
                          </span>
                          <span className="text-muted-foreground text-xs">{unboundCause}</span>
                        </span>
                      ) : (
                        <span className="flex flex-col">
                          {bound.map((connection, i) => (
                            <span key={`${connection.label}-${i}`}>
                              {[
                                connection.label,
                                connection.account_id,
                                t(`run.connSource.${connection.source}`, {
                                  defaultValue: connection.source,
                                }),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          ))}
                        </span>
                      )}
                    </Fact>
                  ))}
                </FactGrid>
              </DetailSectionCard>
            )}

            {metadata && Object.keys(metadata).length > 0 && (
              <DetailSectionCard title={t("run.infoMetadata")} icon={Tags}>
                <FactGrid columns={3}>
                  {Object.entries(metadata).map(([key, value]) => (
                    <Fact key={key} label={key}>
                      {snapshotValue(value)}
                    </Fact>
                  ))}
                </FactGrid>
              </DetailSectionCard>
            )}

            {run.package_ephemeral && (
              <DetailSectionCard title={t("run.technicalDetails")} icon={Code2}>
                {/* Compaction clears an inline run's prompt and manifest. */}
                {run.inline_prompt || run.inline_manifest ? (
                  <FactGrid columns={1}>
                    {run.inline_prompt && (
                      <Fact label={t("run.tabPrompt")}>{run.inline_prompt}</Fact>
                    )}
                    {run.inline_manifest && (
                      <Fact label={t("run.tabManifest")}>
                        {JSON.stringify(run.inline_manifest, null, 2)}
                      </Fact>
                    )}
                  </FactGrid>
                ) : (
                  <p className="text-muted-foreground text-sm">{t("runs.detailsExpired")}</p>
                )}
              </DetailSectionCard>
            )}
          </div>
        </div>
      </div>

      {turnsParam.value !== null && (
        <Modal
          onClose={turnsParam.close}
          title={t("run.turnsTitle")}
          className="max-h-[85vh] max-w-4xl overflow-y-auto"
        >
          <RunTurnsDetail turns={turns} />
        </Modal>
      )}
    </>
  );
}

/**
 * The input the run was given: its values, then the files it consumed. Fed an
 * already-resolved file list, so what it says without `files:read` or under a
 * capped page is testable without a query harness.
 */
export function RunInputFacts({
  run,
  files,
  hasMore,
  isLoading,
  error,
  filesDenied,
}: {
  run: EnrichedRun;
  /** The run's whole file container; its inputs are read off it here. */
  files: FileDto[];
  /** The 100-row page was capped: the container holds more rows. */
  hasMore: boolean;
  isLoading: boolean;
  error: unknown;
  /** The caller may not list files, so none were fetched. */
  filesDenied: boolean;
}) {
  const { t } = useTranslation("agents");
  const inputDocuments = files.filter((file) => runFileDirection(file, run.id) === "input");
  const input = (run.input as Record<string, unknown> | null) ?? null;
  const inputEntries = input ? Object.entries(input) : [];
  const inputValueEntries = inputEntries.filter(([, value]) => !hasDocumentReference(value));
  const inputDocumentEntries = inputEntries.filter(([, value]) => hasDocumentReference(value));
  const inputFileCount = Math.max(run.file_counts.input, countDocumentReferences(input));
  const inputDocumentLabel =
    inputDocumentEntries.length === 1
      ? humanizeInputKey(inputDocumentEntries[0]![0])
      : t("run.snapshotInputFiles");
  // `hasMore` describes the whole container: the inputs are cut only when
  // fewer of them arrived than the run says it consumed.
  const inputsCut = hasMore && inputDocuments.length < inputFileCount;
  const showFiles = inputFileCount > 0 || inputDocuments.length > 0 || isLoading || Boolean(error);

  if (inputValueEntries.length === 0 && !showFiles) {
    return <p className="text-muted-foreground text-sm">{t("run.snapshotNoInput")}</p>;
  }
  return (
    <FactGrid columns={1}>
      {inputValueEntries.map(([key, value]) => (
        <Fact key={key} label={humanizeInputKey(key)}>
          {snapshotValue(value)}
        </Fact>
      ))}
      {showFiles && (
        <Fact label={inputDocumentLabel}>
          <div className="min-w-0">
            <DocumentListPanel
              documents={inputDocuments}
              isLoading={isLoading}
              error={error}
              empty={{
                message: filesDenied
                  ? t("run.noAccess", { ns: "files" })
                  : t("run.snapshotInputFilesUnavailable"),
                compact: true,
              }}
              display="compact"
              footer={
                inputsCut && (
                  <p className="text-muted-foreground text-xs">
                    {t("run.truncated", { ns: "files" })}
                  </p>
                )
              }
            />
          </div>
        </Fact>
      )}
    </FactGrid>
  );
}

function humanizeInputKey(key: string): string {
  const label = key
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return label ? label.charAt(0).toLocaleUpperCase() + label.slice(1) : key;
}

function hasDocumentReference(value: unknown): boolean {
  if (typeof value === "string") return value.startsWith(FILE_URI_PREFIX);
  if (Array.isArray(value)) return value.some(hasDocumentReference);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(hasDocumentReference);
  }
  return false;
}

function countDocumentReferences(value: unknown): number {
  const references = new Set<string>();

  const visit = (candidate: unknown) => {
    if (typeof candidate === "string") {
      if (candidate.startsWith(FILE_URI_PREFIX)) references.add(candidate);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (candidate && typeof candidate === "object") {
      Object.values(candidate as Record<string, unknown>).forEach(visit);
    }
  };

  visit(value);
  return references.size;
}

/**
 * The version a run executed: a concrete semver, or the draft — named with the
 * published version it was edited from, when there is one.
 */
function versionText(run: EnrichedRun, t: TFunction<"agents">): string {
  if (run.version_ref !== "draft") return `v${run.version_ref}`;
  return run.version_label && run.version_label !== "draft"
    ? `${t("run.draft")} (v${run.version_label} ${t("run.versionModified")})`
    : t("run.draft");
}

/** A scalar as text; an array or an object as the payload itself, never a summary of it. */
function snapshotValue(value: unknown): ReactNode {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value == null) return "—";
  return <JsonView data={value} />;
}
