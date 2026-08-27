// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Braces,
  Coins,
  FileCode2,
  FileInput,
  ListTree,
  MessageSquareText,
  Plug,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { formatDuration } from "@appstrate/core/format";
import { JsonView } from "./json-view";
import { SectionCard } from "./section-card";
import { EmptyState } from "./page-states";
import { RunTrigger } from "./run-trigger";
import { RunCostReadout } from "./run-cost-readout";
import { formatDateField } from "../lib/markdown";
import { fractionOfWindow, formatWindowPercent, readRunContext } from "./run-context";
import type { RunTurnRow } from "./log-utils";
import { ACTIVE_RUN_STATUSES, type EnrichedRun, type TokenUsage } from "@appstrate/shared-types";
import { SnapshotAccordionItem } from "./run-detail/snapshot-accordion-item";

interface RunInfoTabProps {
  run: EnrichedRun;
  presentation?: "cards" | "accordion";
  showIdentity?: boolean;
  /**
   * Per-turn breakdown, projected from the run's logs by `buildTurnRows`.
   * Passed down rather than fetched here — `run-detail.tsx` already holds the
   * logs query, and a second fetch would double the request for the same rows.
   * Empty (or absent) for every run predating the turn breadcrumb.
   */
  turns?: RunTurnRow[];
}

const RunInfoPresentationContext = createContext<"cards" | "accordion">("cards");

function InfoCard({ label, value }: { label: string; value: React.ReactNode }) {
  const presentation = useContext(RunInfoPresentationContext);
  return (
    <div
      className={cn(
        presentation === "accordion"
          ? "border-border border-b py-2.5 last:border-b-0"
          : "border-border bg-muted/30 rounded-lg border p-4",
      )}
    >
      <p className="text-muted-foreground mb-1 text-xs">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}

function InfoSection({
  title,
  icon,
  headerRight,
  children,
}: {
  title: string;
  icon: LucideIcon;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}) {
  const presentation = useContext(RunInfoPresentationContext);
  if (presentation === "accordion") {
    return (
      <SnapshotAccordionItem title={title} icon={icon} headerRight={headerRight}>
        {children}
      </SnapshotAccordionItem>
    );
  }
  return (
    <SectionCard title={title} headerRight={headerRight}>
      {children}
    </SectionCard>
  );
}

/**
 * Per-turn breakdown. Totals alone hide WHERE a run started re-reading its
 * whole context, which is what makes a long run expensive — this shows the
 * trend, turn by turn.
 *
 * A table, not a chart: the shape is small, the numbers are the point, and no
 * charting dependency is worth it. The proportional bar behind the context
 * column is pure CSS.
 *
 * The bar is normalized on the run's context WINDOW, not on the run's own peak
 * (#1046). Peak-relative made every run look equally full — the widest bar was
 * always 100 % whether the run had used 5 % or 95 % of what it was given, which
 * is the one thing the column exists to tell apart. This is the same reading
 * the header gauge shows, computed by the same helper so the two cannot drift.
 *
 * FALLBACK, deliberately explicit: when no turn states a window there is no
 * denominator, so the bar reverts to peak-relative AND the `%` column is not
 * rendered at all. No 200k default is invented here — the runner already
 * applies its own default when it has one, so an absent window means genuinely
 * unknown, and a fabricated percentage is worse than none.
 *
 * That switch is ANNOUNCED, in words and in colour. Silently swapping the
 * denominator left a remote-origin run showing a full-width bar on its peak
 * turn under an unchanged header — read, by anyone who saw a windowed run
 * first, as "this turn filled the window", i.e. precisely the misreading #1046
 * exists to remove. The missing `%` column is not a cue: absence never is.
 */
function TurnsTable({ turns }: { turns: RunTurnRow[] }) {
  const { t, i18n } = useTranslation("agents");
  const peak = turns.reduce((max, turn) => Math.max(max, turn.contextTokens), 0);
  // The window comes from the turns, through the very call the header gauge
  // makes — not from a parallel scan of the same rows. One derivation is the
  // only thing that keeps the two surfaces from disagreeing about which turn's
  // window applies, which is the drift #1046 exists to remove. It follows that
  // the table falls back whenever the gauge renders nothing, including on a run
  // whose turns all measured zero: that fallback is announced below, so the
  // reader is never left guessing which denominator they are looking at.
  const contextWindow = readRunContext(turns)?.window ?? null;
  // The denominator the bar is drawn against — the window when known, the run's
  // own peak otherwise. `hasWindow` is what gates the `%` column: a share of a
  // peak is not a share of anything the reader can act on.
  const hasWindow = contextWindow != null && contextWindow > 0;
  const denominator = hasWindow ? contextWindow : peak;

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-muted-foreground border-border border-b text-xs">
              <th scope="col" className="py-1.5 pr-3 text-left font-medium">
                {t("run.turnIndex")}
              </th>
              <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                {t("run.turnContextTokens")}
              </th>
              {hasWindow && (
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                  {t("run.turnContextShare")}
                </th>
              )}
              <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                {t("run.turnOutputTokens")}
              </th>
              <th scope="col" className="py-1.5 text-right font-medium">
                {t("run.turnLatency")}
              </th>
            </tr>
          </thead>
          <tbody>
            {turns.map((turn) => {
              const fraction = fractionOfWindow(turn.contextTokens, denominator);
              return (
                <tr key={turn.index} className="border-border/40 border-b last:border-b-0">
                  <th scope="row" className="py-1 pr-3 text-left font-normal tabular-nums">
                    {turn.index}
                  </th>
                  <td className="relative py-1 pr-3 text-right tabular-nums">
                    {/* Tinted by what the bar is measured against, so the two
                      denominators are not the same picture: the accent fill
                      means "share of the model window", the neutral fill means
                      "share of this run's own peak". */}
                    <span
                      aria-hidden
                      className={cn(
                        "absolute inset-y-0.5 right-0 rounded-sm",
                        hasWindow ? "bg-primary/15" : "bg-muted-foreground/15",
                      )}
                      style={{ width: `${fraction * 100}%` }}
                    />
                    <span className="relative">{turn.contextTokens.toLocaleString()}</span>
                  </td>
                  {hasWindow && (
                    <td className="text-muted-foreground py-1 pr-3 text-right tabular-nums">
                      {formatWindowPercent(fraction, i18n.language)}
                    </td>
                  )}
                  <td className="py-1 pr-3 text-right tabular-nums">
                    {turn.outputTokens.toLocaleString()}
                  </td>
                  <td className="text-muted-foreground py-1 text-right tabular-nums">
                    {/* Omitted by the runner when it could not observe the turn's
                      start — an em dash is honest, a 0 would read as instant. */}
                    {turn.latencyMs !== undefined ? formatDuration(turn.latencyMs) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!hasWindow && (
        <p className="text-muted-foreground mt-2 text-xs">{t("run.turnsPeakRelativeHint")}</p>
      )}
    </>
  );
}

export function RunTurnsDetail({ turns }: { turns: RunTurnRow[] }) {
  const { t } = useTranslation("agents");
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">{t("run.turnsHint")}</p>
      <TurnsTable turns={turns} />
    </div>
  );
}

function formatTimestamp(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return formatDateField(d, "datetime");
}

export function RunInfoTab({
  run,
  turns,
  presentation = "cards",
  showIdentity = true,
}: RunInfoTabProps) {
  const { t } = useTranslation(["agents", "settings"]);
  const input = run.input as Record<string, unknown> | null;
  const config = run.config as Record<string, unknown> | null;
  const usage = run.token_usage as TokenUsage | null;
  const metadata = run.metadata as Record<string, unknown> | null;
  const connectionsUsed = run.connections_used ?? null;
  const hasUsage =
    run.cost != null || run.cost_pricing_status != null || usage != null || run.model_label != null;
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
  const factGridClass =
    presentation === "accordion"
      ? "divide-border divide-y"
      : "grid gap-4 sm:grid-cols-2 lg:grid-cols-3";

  return (
    <RunInfoPresentationContext.Provider value={presentation}>
      <div className={presentation === "cards" ? "space-y-4" : undefined}>
        {/* Version + Trigger — inline runs are not versioned, so the grid
          collapses to a single column when the Version card is hidden. */}
        {showIdentity && (
          <div className={cn("grid gap-4", !run.package_ephemeral && "sm:grid-cols-2")}>
            {!run.package_ephemeral && (
              <InfoCard
                label={t("run.infoVersion")}
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
        )}

        {/* Input */}
        {input && Object.keys(input).length > 0 && (
          <InfoSection title={t("run.infoInput")} icon={FileInput}>
            <JsonView data={input} />
          </InfoSection>
        )}

        {config && Object.keys(config).length > 0 && (
          <InfoSection title={t("run.infoConfig")} icon={Settings2}>
            <JsonView data={config} />
          </InfoSection>
        )}

        {/* Execution — who ran it, when, and with which wiring. Always shown:
          runner origin + startedAt are populated for every run. */}
        <InfoSection title={t("run.infoExecution")} icon={Activity}>
          <div className={factGridClass}>
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
        </InfoSection>

        {/* Usage — `cost` and `tokenUsage` reflect the running totals
          while the run is in progress (patched into the React Query
          cache by `useRunRealtime` `onMetric` events) and the
          authoritative finalize-time values once the run terminates. */}
        {hasUsage ? (
          <InfoSection
            title={t("run.infoUsage")}
            icon={Coins}
            headerRight={
              run.status && (ACTIVE_RUN_STATUSES as ReadonlySet<string>).has(run.status) ? (
                <span className="bg-primary/15 text-primary inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase">
                  <span className="bg-primary size-1.5 animate-pulse rounded-full" aria-hidden />
                  {t("run.usageLive")}
                </span>
              ) : null
            }
          >
            <div className={factGridClass}>
              {/* Shown when there is a number OR a reason there isn't one: an
                `unpriced` run finalizes with `cost = NULL` on purpose, and
                silently dropping the card would hide exactly the case this
                readout exists to report. */}
              {(run.cost != null || run.cost_pricing_status != null) && (
                <InfoCard
                  label={t("run.usageCost")}
                  value={<RunCostReadout cost={run.cost} pricingStatus={run.cost_pricing_status} />}
                />
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
          </InfoSection>
        ) : presentation === "accordion" ? (
          <InfoSection title={t("run.infoUsage")} icon={Coins}>
            <p className="text-muted-foreground text-sm">{t("run.emptyUsage")}</p>
          </InfoSection>
        ) : (
          <EmptyState message={t("run.emptyUsage")} icon={Coins} compact />
        )}

        {/* Per-turn breakdown — absent entirely (not an empty card) when the run
          emitted no turn breadcrumbs, which is every run predating them. */}
        {turns && turns.length > 0 && (
          <InfoSection title={t("run.turnsTitle")} icon={ListTree}>
            <RunTurnsDetail turns={turns} />
          </InfoSection>
        )}

        {/* Connexions — connections resolved for this run, denormalized at
          kickoff so the panel survives a connection rename/deletion. */}
        {connectionsUsed && connectionsUsed.length > 0 && (
          <InfoSection title={t("run.infoConnections")} icon={Plug}>
            <div className={factGridClass}>
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
          </InfoSection>
        )}

        {/* Metadata */}
        {metadata && Object.keys(metadata).length > 0 && (
          <InfoSection title={t("run.infoMetadata")} icon={Braces}>
            <JsonView data={metadata} />
          </InfoSection>
        )}

        {/* Inline run — prompt + manifest snapshot (null after compaction) */}
        {run.package_ephemeral && (
          <>
            {run.inline_prompt ? (
              <InfoSection title={t("run.tabPrompt")} icon={MessageSquareText}>
                <pre className="bg-muted/30 overflow-x-auto rounded-md p-4 font-mono text-xs whitespace-pre-wrap">
                  {run.inline_prompt}
                </pre>
              </InfoSection>
            ) : null}
            {run.inline_manifest ? (
              <InfoSection title={t("run.tabManifest")} icon={FileCode2}>
                <JsonView data={run.inline_manifest} />
              </InfoSection>
            ) : null}
            {!run.inline_prompt &&
              !run.inline_manifest &&
              (presentation === "accordion" ? (
                <InfoSection title={t("run.tabManifest")} icon={FileCode2}>
                  <p className="text-muted-foreground text-sm">{t("runs.detailsExpired")}</p>
                </InfoSection>
              ) : (
                <EmptyState message={t("runs.detailsExpired")} icon={FileCode2} compact />
              ))}
          </>
        )}
      </div>
    </RunInfoPresentationContext.Provider>
  );
}
