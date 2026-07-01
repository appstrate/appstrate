// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Coins, FileCode2 } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { formatDuration } from "@appstrate/core/format";
import { JsonView } from "./json-view";
import { SectionCard } from "./section-card";
import { EmptyState } from "./page-states";
import { RunTrigger } from "./run-trigger";
import { formatDateField } from "../lib/markdown";
import { ACTIVE_RUN_STATUSES, type EnrichedRun, type TokenUsage } from "@appstrate/shared-types";

interface RunInfoTabProps {
  run: EnrichedRun;
}

function InfoCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-border bg-muted/30 rounded-lg border p-4">
      <p className="text-muted-foreground mb-1 text-xs">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}

function formatTimestamp(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return formatDateField(d, "datetime");
}

export function RunInfoTab({ run }: RunInfoTabProps) {
  const { t } = useTranslation(["agents", "settings"]);
  const input = run.input as Record<string, unknown> | null;
  const config = run.config as Record<string, unknown> | null;
  const usage = run.token_usage as TokenUsage | null;
  const metadata = run.metadata as Record<string, unknown> | null;
  const connectionsUsed = run.connections_used ?? null;
  const hasUsage = run.cost != null || usage != null || run.model_label != null;
  const runnerOriginLabel =
    run.runOrigin === "remote" ? t("run.infoRunnerRemote") : t("run.infoRunnerPlatform");
  // Append the runner name when present so the dashboard shows
  // "Distant · pierres-mbp" or "Distant · acme/web #42" instead of the
  // bare origin word.
  const runnerLabel = run.runner_name
    ? `${runnerOriginLabel} · ${run.runner_name}`
    : runnerOriginLabel;
  const startedAt = formatTimestamp(run.started_at);
  const completedAt = formatTimestamp(run.completed_at);

  return (
    <div className="space-y-4">
      {/* Version + Trigger — inline runs are not versioned, so the grid
          collapses to a single column when the Version card is hidden. */}
      <div className={cn("grid gap-4", !run.package_ephemeral && "sm:grid-cols-2")}>
        {!run.package_ephemeral && (
          <InfoCard
            label="Version"
            value={
              <span className={cn("font-mono", run.version_ref === "draft" && "italic")}>
                {/* version_ref is unambiguous (#636): a concrete semver when the
                    run executed a published definition, "draft" otherwise. For
                    draft runs, surface the published base version when known. */}
                {run.version_ref !== "draft"
                  ? `v${run.version_ref}`
                  : run.version_label && run.version_label !== "draft"
                    ? `${t("run.draft")} (v${run.version_label} ${t("run.versionModified")})`
                    : t("run.draft")}
              </span>
            }
          />
        )}
        <InfoCard label={t("run.infoTrigger")} value={<RunTrigger run={run} />} />
      </div>

      {/* Input */}
      {input && Object.keys(input).length > 0 && (
        <SectionCard title={t("run.infoInput")}>
          <JsonView data={input} />
        </SectionCard>
      )}

      {config && Object.keys(config).length > 0 && (
        <SectionCard title={t("run.infoConfig")}>
          <JsonView data={config} />
        </SectionCard>
      )}

      {/* Execution — who ran it, when, and with which wiring. Always shown:
          runner origin + startedAt are populated for every run. */}
      <SectionCard title={t("run.infoExecution")}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <InfoCard label={t("run.infoRunner")} value={runnerLabel} />
          {run.duration != null && (
            <InfoCard label={t("run.infoDuration")} value={formatDuration(run.duration)} />
          )}
          {startedAt && <InfoCard label={t("run.infoStartedAt")} value={startedAt} />}
          {completedAt && <InfoCard label={t("run.infoCompletedAt")} value={completedAt} />}
          {run.model_label != null && (
            <InfoCard label={t("run.usageModel")} value={run.model_label} />
          )}
          {run.proxy_label != null && (
            <InfoCard label={t("run.infoProxy")} value={run.proxy_label} />
          )}
        </div>
      </SectionCard>

      {/* Usage — `cost` and `tokenUsage` reflect the running totals
          while the run is in progress (patched into the React Query
          cache by `useRunRealtime` `onMetric` events) and the
          authoritative finalize-time values once the run terminates. */}
      {hasUsage ? (
        <SectionCard
          title={t("run.infoUsage")}
          headerRight={
            run.status && (ACTIVE_RUN_STATUSES as ReadonlySet<string>).has(run.status) ? (
              <span className="bg-primary/15 text-primary inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase">
                <span className="bg-primary size-1.5 animate-pulse rounded-full" aria-hidden />
                {t("run.usageLive")}
              </span>
            ) : null
          }
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {run.cost != null && (
              <InfoCard label={t("run.usageCost")} value={`$${run.cost.toFixed(4)}`} />
            )}
            {usage?.input_tokens != null && (
              <InfoCard
                label={t("run.usageInputTokens")}
                value={usage.input_tokens.toLocaleString()}
              />
            )}
            {usage?.output_tokens != null && (
              <InfoCard
                label={t("run.usageOutputTokens")}
                value={usage.output_tokens.toLocaleString()}
              />
            )}
            {usage?.cache_creation_input_tokens != null && (
              <InfoCard
                label={t("run.usageCacheCreation")}
                value={usage.cache_creation_input_tokens.toLocaleString()}
              />
            )}
            {usage?.cache_read_input_tokens != null && (
              <InfoCard
                label={t("run.usageCacheRead")}
                value={usage.cache_read_input_tokens.toLocaleString()}
              />
            )}
          </div>
        </SectionCard>
      ) : (
        <EmptyState message={t("run.emptyUsage")} icon={Coins} compact />
      )}

      {/* Connexions — connections resolved for this run, denormalized at
          kickoff so the panel survives a connection rename/deletion. */}
      {connectionsUsed && connectionsUsed.length > 0 && (
        <SectionCard title={t("run.infoConnections")}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {connectionsUsed.map((c) => (
              <InfoCard
                key={c.integration_id}
                label={c.integration_id}
                value={
                  <span className="flex flex-col">
                    <span>{c.label ?? c.account_id ?? "—"}</span>
                    {c.label && c.account_id && (
                      <span className="text-muted-foreground text-xs">{c.account_id}</span>
                    )}
                    <span className="text-muted-foreground text-xs">
                      {t(`run.connSource.${c.source}`, { defaultValue: c.source })}
                    </span>
                  </span>
                }
              />
            ))}
          </div>
        </SectionCard>
      )}

      {/* Metadata */}
      {metadata && Object.keys(metadata).length > 0 && (
        <SectionCard title="Metadata">
          <JsonView data={metadata} />
        </SectionCard>
      )}

      {/* Inline run — prompt + manifest snapshot (null after compaction) */}
      {run.package_ephemeral && (
        <>
          {run.inline_prompt ? (
            <SectionCard title={t("run.tabPrompt")}>
              <pre className="bg-muted/30 overflow-x-auto rounded-md p-4 font-mono text-xs whitespace-pre-wrap">
                {run.inline_prompt}
              </pre>
            </SectionCard>
          ) : null}
          {run.inline_manifest ? (
            <SectionCard title={t("run.tabManifest")}>
              <JsonView data={run.inline_manifest} />
            </SectionCard>
          ) : null}
          {!run.inline_prompt && !run.inline_manifest && (
            <EmptyState message={t("runs.detailsExpired")} icon={FileCode2} compact />
          )}
        </>
      )}
    </div>
  );
}
