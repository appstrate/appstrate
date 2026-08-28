// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  ArrowRight,
  ChartNoAxesCombined,
  CirclePlay,
  Code2,
  FileInput,
  Link2,
  Settings2,
  Tags,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import type { EnrichedRun, TokenUsage } from "@appstrate/shared-types";
import { RunTurnsDetail } from "../run-info-tab";
import type { RunTurnRow } from "../log-utils";
import { RunCostReadout } from "../run-cost-readout";
import { Modal } from "../modal";
import { useDocuments } from "../../hooks/use-documents";
import { DocumentListPanel } from "../document-list-panel";
import { formatDateField } from "../../lib/markdown";
import { getRunTriggerActor, getRunTriggerType } from "../run-trigger";
import type { ExecutionEntry } from "../log-utils";
import { OverviewCardAction } from "../overview-card-action";
import type { JournalOverviewFilter } from "../log-viewer";
import { RunDuration } from "../run-duration";

export function RunSnapshotInspector({
  run,
  turns,
  logs,
  structuredOutput,
  memoryChangeCount,
  onOpenJournal,
  onOpenResults,
  cardHeaders = false,
  contained = false,
}: {
  run: EnrichedRun;
  turns: RunTurnRow[];
  logs: ExecutionEntry[];
  structuredOutput: Record<string, unknown> | null;
  memoryChangeCount: number;
  onOpenJournal: (filter?: JournalOverviewFilter) => void;
  onOpenResults: () => void;
  cardHeaders?: boolean;
  contained?: boolean;
}) {
  const { t } = useTranslation("agents");
  const [turnsOpen, setTurnsOpen] = useState(false);
  const inputDocumentsQuery = useDocuments({
    runId: run.id,
    purpose: "user_upload",
    limit: 100,
  });
  const inputDocuments = inputDocumentsQuery.data?.data ?? [];
  const input = (run.input as Record<string, unknown> | null) ?? null;
  const inputEntries = input ? Object.entries(input) : [];
  const inputValueEntries = inputEntries.filter(([, value]) => !hasDocumentReference(value));
  const inputDocumentEntries = inputEntries.filter(([, value]) => hasDocumentReference(value));
  const inputFileCount = Math.max(run.document_counts.input, countDocumentReferences(input));
  const inputDocumentLabel =
    inputDocumentEntries.length === 1
      ? humanizeInputKey(inputDocumentEntries[0]![0])
      : t("run.snapshotInputFiles");
  const config = (run.config as Record<string, unknown> | null) ?? null;
  const metadata = (run.metadata as Record<string, unknown> | null) ?? null;
  const usage = run.token_usage as TokenUsage | null;
  const connections = run.connections_used ?? [];
  const agentExecuted =
    [run.agent_scope, run.agent_name].filter(Boolean).join("/") || t("run.unknownValue");
  const triggerActor = getRunTriggerActor(run);
  const runnerLabel =
    run.runner_name ??
    (run.runOrigin === "remote" ? t("run.infoRunnerRemote") : t("run.infoRunnerPlatform"));
  const toolCallCount = logs.filter((entry) => entry.kind === "tool").length;
  const warningCount = logs.filter(
    (entry) => entry.level === "warn" || entry.level === "warning",
  ).length;
  const errorCount = logs.filter(
    (entry) =>
      entry.level === "error" ||
      (entry.kind === "tool" && ["failed", "interrupted"].includes(entry.status)),
  ).length;
  const structuredFieldCount = Object.keys(structuredOutput ?? {}).length;

  return (
    <>
      <div
        data-run-snapshot
        className={contained ? undefined : cardHeaders ? "py-4 md:py-6" : "p-4 md:p-6"}
      >
        <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]">
          <div className="grid min-w-0 content-start gap-6 lg:grid-cols-2">
            <RunDetailCard
              title={t("run.infoExecution")}
              icon={CirclePlay}
              className="lg:col-span-2"
              headerInside={cardHeaders}
            >
              <SnapshotFacts columns four>
                <SnapshotFact label={t("run.sourceAgent")} value={agentExecuted} />
                {!run.package_ephemeral && (
                  <SnapshotFact
                    label={t("run.infoVersion")}
                    value={run.version_ref === "draft" ? t("run.draft") : `v${run.version_ref}`}
                  />
                )}
                <SnapshotFact
                  label={t("run.infoTriggerType")}
                  value={t(`run.triggerType.${getRunTriggerType(run)}`)}
                />
                {triggerActor && (
                  <SnapshotFact label={t("run.infoTriggeredBy")} value={triggerActor} />
                )}
                <SnapshotFact label={t("run.infoRunner")} value={runnerLabel} />
                {run.started_at && (
                  <SnapshotFact
                    label={t("run.infoStartedAt")}
                    value={formatDateField(run.started_at, "datetime")}
                  />
                )}
                {run.completed_at && (
                  <SnapshotFact
                    label={t("run.infoCompletedAt")}
                    value={formatDateField(run.completed_at, "datetime")}
                  />
                )}
                {(run.duration != null || run.started_at) && (
                  <SnapshotFact
                    label={t("run.infoDuration")}
                    value={
                      <RunDuration
                        status={run.status}
                        startedAt={run.started_at}
                        duration={run.duration}
                        className="text-foreground font-sans text-sm"
                      />
                    }
                  />
                )}
                {run.proxy_label && (
                  <SnapshotFact label={t("run.infoProxy")} value={run.proxy_label} />
                )}
              </SnapshotFacts>
            </RunDetailCard>

            <RunDetailCard
              title={t("run.overview.activity")}
              icon={Activity}
              bodyClassName="p-0"
              headerInside={cardHeaders}
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
                <OverviewMetric
                  className="border-border border-r border-b"
                  label={t("run.overview.logEvents")}
                  value={logs.length.toLocaleString()}
                  onClick={logs.length > 0 ? () => onOpenJournal() : undefined}
                />
                <OverviewMetric
                  className="border-border border-b"
                  label={t("run.overview.toolCalls")}
                  value={toolCallCount.toLocaleString()}
                  onClick={toolCallCount > 0 ? () => onOpenJournal("tools") : undefined}
                />
                <OverviewMetric
                  className="border-border border-r"
                  label={t("run.overview.warnings")}
                  value={warningCount.toLocaleString()}
                  onClick={warningCount > 0 ? () => onOpenJournal("warnings") : undefined}
                />
                <OverviewMetric
                  label={t("run.overview.errors")}
                  value={errorCount.toLocaleString()}
                  onClick={errorCount > 0 ? () => onOpenJournal("errors") : undefined}
                />
              </dl>
            </RunDetailCard>

            <RunDetailCard
              title={t("run.overview.results")}
              icon={Trophy}
              bodyClassName="p-0"
              headerInside={cardHeaders}
              headerAction={
                run.document_counts.output + structuredFieldCount + memoryChangeCount > 0
                  ? {
                      label: t("run.overview.openResults"),
                      onClick: onOpenResults,
                    }
                  : undefined
              }
            >
              <dl className="grid grid-cols-2">
                <OverviewMetric
                  className="border-border border-r border-b"
                  label={t("run.overview.outputFiles")}
                  value={run.document_counts.output.toLocaleString()}
                  onClick={run.document_counts.output > 0 ? onOpenResults : undefined}
                />
                <OverviewMetric
                  className="border-border border-b"
                  label={t("run.overview.structuredFields")}
                  value={structuredFieldCount.toLocaleString()}
                  onClick={structuredFieldCount > 0 ? onOpenResults : undefined}
                />
                <OverviewMetric
                  className="col-span-2"
                  label={t("run.overview.memoryChanges")}
                  value={memoryChangeCount.toLocaleString()}
                  onClick={memoryChangeCount > 0 ? onOpenResults : undefined}
                />
              </dl>
            </RunDetailCard>
          </div>

          <div className="grid min-w-0 content-start gap-6">
            <RunDetailCard
              title={t("run.infoUsage")}
              icon={ChartNoAxesCombined}
              bodyClassName="flex flex-col p-0"
              headerInside={cardHeaders}
            >
              <div className="flex-1 p-4">
                <SnapshotFacts columns>
                  {(run.cost != null || run.cost_pricing_status != null) && (
                    <SnapshotFact
                      label={t("run.usageEstimatedApiCost")}
                      value={
                        <RunCostReadout cost={run.cost} pricingStatus={run.cost_pricing_status} />
                      }
                    />
                  )}
                  {run.model_label && (
                    <SnapshotFact label={t("run.usageModel")} value={run.model_label} />
                  )}
                  {usage?.input_tokens != null && (
                    <SnapshotFact
                      label={t("run.usageInputTokens")}
                      value={usage.input_tokens.toLocaleString()}
                    />
                  )}
                  {usage?.output_tokens != null && (
                    <SnapshotFact
                      label={t("run.usageOutputTokens")}
                      value={usage.output_tokens.toLocaleString()}
                    />
                  )}
                  {usage?.cache_creation_input_tokens != null && (
                    <SnapshotFact
                      label={t("run.usageCacheCreation")}
                      value={usage.cache_creation_input_tokens.toLocaleString()}
                    />
                  )}
                  {usage?.cache_read_input_tokens != null && (
                    <SnapshotFact
                      label={t("run.usageCacheRead")}
                      value={usage.cache_read_input_tokens.toLocaleString()}
                    />
                  )}
                </SnapshotFacts>
              </div>
              {turns.length > 0 && (
                <OverviewCardAction onClick={() => setTurnsOpen(true)}>
                  {t("run.viewTurnDetails")}
                </OverviewCardAction>
              )}
            </RunDetailCard>

            <RunDetailCard title={t("run.infoInput")} icon={FileInput} headerInside={cardHeaders}>
              {inputValueEntries.length === 0 &&
              inputFileCount === 0 &&
              inputDocuments.length === 0 &&
              !inputDocumentsQuery.isLoading &&
              !inputDocumentsQuery.error ? (
                <p className="text-muted-foreground text-sm">{t("run.snapshotNoInput")}</p>
              ) : (
                <SnapshotFacts>
                  {inputValueEntries.map(([key, value]) => (
                    <SnapshotFact
                      key={key}
                      label={humanizeInputKey(key)}
                      value={formatSnapshotValue(value)}
                    />
                  ))}
                  {(inputFileCount > 0 ||
                    inputDocumentsQuery.isLoading ||
                    Boolean(inputDocumentsQuery.error)) && (
                    <SnapshotFact
                      label={inputDocumentLabel}
                      value={
                        <div className="min-w-0">
                          <DocumentListPanel
                            documents={inputDocuments}
                            isLoading={inputDocumentsQuery.isLoading}
                            error={inputDocumentsQuery.error}
                            empty={{
                              message: t("run.snapshotInputFilesUnavailable"),
                              compact: true,
                            }}
                            showPurposeTabs={false}
                            display="compact"
                          />
                        </div>
                      }
                    />
                  )}
                </SnapshotFacts>
              )}
            </RunDetailCard>

            {connections.length > 0 && (
              <RunDetailCard
                title={t("run.infoConnections")}
                icon={Link2}
                headerInside={cardHeaders}
              >
                <SnapshotFacts>
                  {connections.map((connection) => (
                    <SnapshotFact
                      key={connection.integration_id}
                      label={connection.integration_id}
                      value={[
                        connection.label,
                        connection.account_id,
                        t(`run.connSource.${connection.source}`, {
                          defaultValue: connection.source,
                        }),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    />
                  ))}
                </SnapshotFacts>
              </RunDetailCard>
            )}

            {config && Object.keys(config).length > 0 && (
              <RunDetailCard
                title={t("run.infoConfig")}
                icon={Settings2}
                headerInside={cardHeaders}
              >
                <SnapshotFacts columns>
                  {Object.entries(config).map(([key, value]) => (
                    <SnapshotFact key={key} label={key} value={formatSnapshotValue(value)} />
                  ))}
                </SnapshotFacts>
              </RunDetailCard>
            )}

            {metadata && Object.keys(metadata).length > 0 && (
              <RunDetailCard title={t("run.infoMetadata")} icon={Tags} headerInside={cardHeaders}>
                <SnapshotFacts columns wide>
                  {Object.entries(metadata).map(([key, value]) => (
                    <SnapshotFact key={key} label={key} value={formatSnapshotValue(value)} />
                  ))}
                </SnapshotFacts>
              </RunDetailCard>
            )}

            {run.package_ephemeral && (run.inline_prompt || run.inline_manifest) && (
              <RunDetailCard
                title={t("run.technicalDetails")}
                icon={Code2}
                headerInside={cardHeaders}
              >
                <SnapshotFacts>
                  {run.inline_prompt && (
                    <SnapshotFact label={t("run.tabPrompt")} value={run.inline_prompt} />
                  )}
                  {run.inline_manifest && (
                    <SnapshotFact
                      label={t("run.tabManifest")}
                      value={JSON.stringify(run.inline_manifest, null, 2)}
                    />
                  )}
                </SnapshotFacts>
              </RunDetailCard>
            )}
          </div>
        </div>
      </div>

      <Modal
        open={turnsOpen}
        onClose={() => setTurnsOpen(false)}
        title={t("run.turnsTitle")}
        className="max-h-[85vh] max-w-4xl overflow-y-auto"
      >
        <RunTurnsDetail turns={turns} />
      </Modal>
    </>
  );
}

function OverviewMetric({
  label,
  value,
  className,
  onClick,
}: {
  label: string;
  value: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <dt className="text-muted-foreground w-full text-left text-xs font-medium">{label}</dt>
      <dd className="mt-1 w-full text-left text-xl font-semibold tabular-nums">{value}</dd>
    </>
  );

  return (
    <div className={`min-w-0 ${className ?? ""}`}>
      {onClick ? (
        <button
          type="button"
          className="group hover:bg-muted/20 focus-visible:ring-ring relative flex h-full min-h-20 w-full flex-col justify-center px-4 py-4 pr-10 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset"
          onClick={onClick}
        >
          {content}
          <ArrowRight className="text-muted-foreground/45 group-hover:text-primary group-focus-visible:text-primary absolute top-1/2 right-4 size-4 -translate-y-1/2 opacity-70 transition-all group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:translate-x-0.5 group-focus-visible:opacity-100" />
        </button>
      ) : (
        <div className="flex h-full min-h-20 flex-col justify-center px-4 py-4">{content}</div>
      )}
    </div>
  );
}

function RunDetailCard({
  title,
  icon: Icon,
  headerAction,
  className,
  bodyClassName,
  headerInside = false,
  children,
}: {
  title: string;
  icon: LucideIcon;
  headerAction?: { label: string; onClick: () => void };
  className?: string;
  bodyClassName?: string;
  headerInside?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`flex min-w-0 flex-col ${headerInside ? "bg-muted/35 overflow-hidden rounded-lg border" : ""} ${className ?? ""}`}
    >
      {headerAction ? (
        <button
          type="button"
          aria-label={headerAction.label}
          title={headerAction.label}
          onClick={headerAction.onClick}
          className={`${headerInside ? "bg-muted/35 hover:bg-muted px-4 py-3" : "hover:bg-muted/40 mb-2 rounded-sm"} group focus-visible:ring-ring flex min-h-5 w-full items-center gap-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset`}
        >
          <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
          <ArrowRight className="text-muted-foreground group-hover:text-primary group-focus-visible:text-primary size-4 shrink-0 transition-all group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5" />
        </button>
      ) : (
        <div
          className={`${headerInside ? "bg-muted/35 px-4 py-3" : "mb-2"} flex min-h-5 items-center gap-2`}
        >
          <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
        </div>
      )}
      <div
        className={`bg-card h-full overflow-hidden ${headerInside ? "rounded-t-lg border-x-0 border-t border-b-0" : "rounded-lg border"} ${bodyClassName ?? "p-4"}`}
      >
        {children}
      </div>
    </section>
  );
}

function SnapshotFacts({
  children,
  columns = false,
  four = false,
  wide = false,
}: {
  children: ReactNode;
  columns?: boolean;
  four?: boolean;
  wide?: boolean;
}) {
  if (columns) {
    return (
      <dl
        className={
          four
            ? "grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4"
            : wide
              ? "grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3"
              : "grid gap-x-8 gap-y-4 sm:grid-cols-2"
        }
      >
        {children}
      </dl>
    );
  }
  return <dl className="grid gap-y-3">{children}</dl>;
}

function SnapshotFact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
      <dd className="text-foreground [&>span]:text-foreground mt-1 min-w-0 text-sm break-words whitespace-pre-wrap [&>span]:text-sm">
        {value}
      </dd>
    </div>
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
  if (typeof value === "string") return value.startsWith("document://");
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
      if (candidate.startsWith("document://")) references.add(candidate);
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

function formatSnapshotValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value == null) return "—";
  if (Array.isArray(value)) return String(value.length);
  return JSON.stringify(value);
}
