// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Coins, FileCode2 } from "lucide-react";
import { cn } from "../lib/utils";
import { JsonView } from "./json-view";
import { SectionCard } from "./section-card";
import { EmptyState } from "./page-states";
import { ProviderStatusRow } from "./provider-status-row";
import { RunTrigger } from "./run-trigger";
import { useProviders } from "../hooks/use-providers";
import type { EnrichedRun, RunProviderSnapshot } from "@appstrate/shared-types";

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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes}m ${rest}s`;
}

function formatTimestamp(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString();
}

export function RunInfoTab({ run }: RunInfoTabProps) {
  const { t } = useTranslation(["agents", "settings"]);
  const { data: providersData } = useProviders();
  const providerStatuses = run.providerStatuses as RunProviderSnapshot[] | null;
  const input = run.input as Record<string, unknown> | null;
  const config = run.config as Record<string, unknown> | null;
  const usage = run.tokenUsage as {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  } | null;
  const metadata = run.metadata as Record<string, unknown> | null;
  const hasUsage = run.cost != null || usage != null || run.modelLabel != null;
  const runnerOriginLabel =
    run.runOrigin === "remote" ? t("exec.infoRunnerRemote") : t("exec.infoRunnerPlatform");
  // Append the runner name when present so the dashboard shows
  // "Distant · pierres-mbp" or "Distant · acme/web #42" instead of the
  // bare origin word.
  const runnerLabel = run.runnerName
    ? `${runnerOriginLabel} · ${run.runnerName}`
    : runnerOriginLabel;
  const startedAt = formatTimestamp(run.startedAt);
  const completedAt = formatTimestamp(run.completedAt);

  return (
    <div className="space-y-4">
      {/* Version + Trigger — inline runs are not versioned, so the grid
          collapses to a single column when the Version card is hidden. */}
      <div className={cn("grid gap-4", !run.packageEphemeral && "sm:grid-cols-2")}>
        {!run.packageEphemeral && (
          <InfoCard
            label="Version"
            value={
              <span className={cn("font-mono", !run.versionLabel && "italic")}>
                {run.versionLabel
                  ? `v${run.versionLabel}${run.versionDirty ? ` ${t("exec.versionDirty")}` : ""}`
                  : t("exec.draft")}
              </span>
            }
          />
        )}
        <InfoCard label={t("exec.infoTrigger")} value={<RunTrigger run={run} />} />
      </div>

      {/* Connections */}
      {providerStatuses && providerStatuses.length > 0 && (
        <SectionCard title={t("exec.infoConnections")}>
          <div className="space-y-1.5">
            {providerStatuses.map((svc) => {
              const providerMeta = providersData?.providers?.find((p) => p.id === svc.id);
              return (
                <ProviderStatusRow
                  key={svc.id}
                  id={svc.id}
                  status={svc.status}
                  source={svc.source}
                  profileName={svc.profileName}
                  profileOwnerName={svc.profileOwnerName}
                  scopesSufficient={svc.scopesSufficient}
                  displayName={providerMeta?.displayName ?? svc.id}
                  iconUrl={providerMeta?.iconUrl}
                />
              );
            })}
          </div>
        </SectionCard>
      )}

      {/* Input */}
      {input && Object.keys(input).length > 0 && (
        <SectionCard title={t("exec.infoInput")}>
          <JsonView data={input} />
        </SectionCard>
      )}

      {config && Object.keys(config).length > 0 && (
        <SectionCard title={t("exec.infoConfig")}>
          <JsonView data={config} />
        </SectionCard>
      )}

      {/* Execution — who ran it, when, and with which wiring. Always shown:
          runner origin + startedAt are populated for every run. */}
      <SectionCard title={t("exec.infoExecution")}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <InfoCard label={t("exec.infoRunner")} value={runnerLabel} />
          {run.duration != null && (
            <InfoCard label={t("exec.infoDuration")} value={formatDuration(run.duration)} />
          )}
          {startedAt && <InfoCard label={t("exec.infoStartedAt")} value={startedAt} />}
          {completedAt && <InfoCard label={t("exec.infoCompletedAt")} value={completedAt} />}
          {run.modelLabel != null && (
            <InfoCard label={t("exec.usageModel")} value={run.modelLabel} />
          )}
          {run.proxyLabel != null && (
            <InfoCard label={t("exec.infoProxy")} value={run.proxyLabel} />
          )}
        </div>
      </SectionCard>

      {/* Usage */}
      {hasUsage ? (
        <SectionCard title={t("exec.infoUsage")}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {run.cost != null && (
              <InfoCard label={t("exec.usageCost")} value={`$${run.cost.toFixed(4)}`} />
            )}
            {usage?.input_tokens != null && (
              <InfoCard
                label={t("exec.usageInputTokens")}
                value={usage.input_tokens.toLocaleString()}
              />
            )}
            {usage?.output_tokens != null && (
              <InfoCard
                label={t("exec.usageOutputTokens")}
                value={usage.output_tokens.toLocaleString()}
              />
            )}
            {usage?.cache_creation_input_tokens != null && (
              <InfoCard
                label={t("exec.usageCacheCreation")}
                value={usage.cache_creation_input_tokens.toLocaleString()}
              />
            )}
            {usage?.cache_read_input_tokens != null && (
              <InfoCard
                label={t("exec.usageCacheRead")}
                value={usage.cache_read_input_tokens.toLocaleString()}
              />
            )}
          </div>
        </SectionCard>
      ) : (
        <EmptyState message={t("exec.emptyUsage")} icon={Coins} compact />
      )}

      {/* Metadata */}
      {metadata && Object.keys(metadata).length > 0 && (
        <SectionCard title="Metadata">
          <JsonView data={metadata} />
        </SectionCard>
      )}

      {/* Inline run — prompt + manifest snapshot (null after compaction) */}
      {run.packageEphemeral && (
        <>
          {run.inlinePrompt ? (
            <SectionCard title={t("exec.tabPrompt")}>
              <pre className="bg-muted/30 overflow-x-auto rounded-md p-4 font-mono text-xs whitespace-pre-wrap">
                {run.inlinePrompt}
              </pre>
            </SectionCard>
          ) : null}
          {run.inlineManifest ? (
            <SectionCard title={t("exec.tabManifest")}>
              <JsonView data={run.inlineManifest} />
            </SectionCard>
          ) : null}
          {!run.inlinePrompt && !run.inlineManifest && (
            <EmptyState message={t("runs.detailsExpired")} icon={FileCode2} compact />
          )}
        </>
      )}
    </div>
  );
}
