// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Shield, FileInput, FileOutput, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "./status-badge";
import { RunTrigger } from "./run-trigger";
import { RunTokensReadout } from "./run-tokens-readout";
import { RunTypeBadge } from "./run-type-badge";
import { Button } from "@appstrate/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { cn } from "@appstrate/ui/cn";
import { formatDateField } from "../lib/format-date";
import type { TokenUsage } from "@appstrate/core/token-usage";
import { ACTIVE_RUN_STATUSES, type EnrichedRun } from "@appstrate/shared-types";

/**
 * `list` — a navigable row in a run list. `detail` — the same row pinned under
 * the run-detail page header, where the page title, the tabs and the banners
 * already carry most of the columns, so they move into the details panel.
 *
 * This replaces the old `disableLink` boolean, which meant "rendered on the
 * detail page" under a name that described only one of its consequences. Two
 * props for one distinction is exactly the duplication #1046 exists to remove.
 */
type RunRowVariant = "list" | "detail";

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

/**
 * The facts the `detail` variant drops from its always-visible line that have
 * nowhere else to live. Deliberately NOT here — another pane is their sole
 * owner, and duplicating them was the crowding this pass removes:
 *   - trigger → `run-configuration-tab.tsx` (`run.infoTrigger`)
 *   - start date, proxy → `run-execution-tab.tsx` (`run.infoStartedAt`,
 *     `run.infoProxy`)
 *   - the four token buckets → same pane; only their SUM is here, because that
 *     is the figure #1046 demotes from the header and the pane never shows it
 *   - `#N` → the page title
 *   - the run TYPE → the top line itself, in both variants, via `RunTypeBadge`
 * The Fichiers tab badge shows a total, never the in/out split, so the split
 * stays.
 *
 * Exported as a testing affordance: the popover keeps its content unmounted
 * until opened, and the web test runner has no DOM to open it with.
 */
export function RunRowDetails({ run }: { run: EnrichedRun }) {
  const { t } = useTranslation(["agents"]);
  const inputFiles = run.file_counts.input;
  const outputFiles = run.file_counts.output;

  return (
    <div className="space-y-2">
      {(inputFiles > 0 || outputFiles > 0) && (
        <DetailRow label={t("run.tabFiles")}>
          {t("run.detailsFiles", { input: inputFiles, output: outputFiles })}
        </DetailRow>
      )}
      <DetailRow label={t("run.usageTokensTotal")}>
        <RunTokensReadout usage={run.token_usage as TokenUsage | null} />
      </DetailRow>
    </div>
  );
}

/** Seconds-with-one-decimal, the format both the live and the final figure use. */
function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Live elapsed time of a running run, ticking at 10 Hz.
 *
 * A LEAF on purpose: the interval used to live in `RunRow`, so every tick
 * re-rendered the whole row — badges, trigger, popover, links — ten times a
 * second, per running run on screen. Here the state that changes is owned by
 * the only node that displays it, so a tick re-renders one `<span>`.
 *
 * Exported for the unit test, which asserts exactly that isolation.
 */
export function ElapsedDuration({ startedAt }: { startedAt: string }) {
  const [elapsed, setElapsed] = useState(() => Date.now() - new Date(startedAt).getTime());

  useEffect(() => {
    const start = new Date(startedAt).getTime();
    const tick = () => setElapsed(Date.now() - start);
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [startedAt]);

  // Mirrors the pre-split behaviour: a run that has not measurably started yet
  // renders nothing rather than a flickering `0.0s`.
  if (!elapsed) return null;
  return <span className="text-muted-foreground font-mono text-xs">{formatDuration(elapsed)}</span>;
}

export function RunRow({
  run,
  agentName,
  variant = "list",
}: {
  run: EnrichedRun;
  agentName?: string;
  variant?: RunRowVariant;
}) {
  const { t } = useTranslation(["agents"]);
  const isRunning = (ACTIVE_RUN_STATUSES as ReadonlySet<string>).has(run.status);
  const isUnread = run.unread;
  const date = run.started_at ? formatDateField(run.started_at) : "";
  const isInline = run.package_ephemeral === true;
  const isRemote = run.runOrigin === "remote";
  const isDetail = variant === "detail";
  // Source agent deleted (FK SET NULL after migration 0017): the run row
  // survives but `/agents/:packageId/runs/:id` would 404. Render as a static
  // row pointing at the global run page instead, and surface a discreet
  // badge so users understand why "Re-run" / agent-config links are gone.
  const isOrphaned = run.packageId == null && !isInline;

  // While the run is live the elapsed time ticks inside `<ElapsedDuration>`;
  // once it is over the row renders the frozen `duration` itself. Neither path
  // re-renders this component on a timer.
  const isLive = isRunning && run.started_at != null;
  const finalDuration = run.duration ? formatDuration(run.duration) : "";

  // `file_counts` is a non-optional field of the run DTO — every list and
  // detail endpoint computes it — so read it straight.
  const inputFiles = run.file_counts.input;
  const outputFiles = run.file_counts.output;

  const content = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {/* `#N` duplicates the detail page's own title, so the detail variant
          drops it outright rather than moving it into the panel. */}
      {!isDetail && run.runNumber != null && (
        <span className="text-muted-foreground shrink-0 font-mono text-xs">#{run.runNumber}</span>
      )}
      {agentName && <span className="truncate font-medium">{agentName}</span>}
      <Badge status={run.status} compact unread={isUnread} />
      {/* Run TYPE — inline vs catalogued agent. Always on the detail page's top
          bar: nothing else there tells the two apart, and they behave
          differently (no version, no re-run for an inline run). In a list the
          chip is inline-only, as before — every row of an agent's run list
          saying "AGENT" is noise, while an inline row among them is the
          exception worth marking. */}
      {(isDetail || isInline) && <RunTypeBadge run={run} />}
      {/* These two stay inline in BOTH variants: they are the reason the
          Re-run / Cancel buttons beside them are missing. Hiding them behind a
          click would leave that absence unexplained. */}
      {isOrphaned && (
        <span
          className="border-border text-muted-foreground shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase italic"
          title={t("runs.deletedAgentTitle")}
        >
          {t("runs.deletedAgentBadge")}
        </span>
      )}
      {isRemote && (
        <span
          className="border-border text-muted-foreground shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase"
          title={t("runs.remoteBadgeTitle")}
        >
          {t("runs.remoteBadge")}
        </span>
      )}

      {/* Trigger, proxy and (below) the start date are list-only: on the detail
          page other panes already own all three — trigger in
          `run-configuration-tab.tsx`, proxy and start date in
          `run-execution-tab.tsx` (see this file's `RunRowDetails` note) — so
          they are dropped outright rather than moved into the panel. */}
      {!isDetail && <RunTrigger run={run} />}

      {!isDetail && run.proxy_label && (
        <Shield size={12} className="text-muted-foreground hidden shrink-0 sm:block" />
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {/* File counts duplicate the Files tab badge on the detail page. */}
        {!isDetail && inputFiles > 0 && (
          <span
            className="text-muted-foreground flex items-center gap-0.5 text-xs"
            title={t("run.inputFiles", { count: inputFiles })}
          >
            <FileInput size={12} className="shrink-0" />
            {inputFiles}
          </span>
        )}
        {!isDetail && outputFiles > 0 && (
          <span
            className="text-muted-foreground flex items-center gap-0.5 text-xs"
            title={t("run.outputFiles", { count: outputFiles })}
          >
            <FileOutput size={12} className="shrink-0" />
            {outputFiles}
          </span>
        )}
        {/* How long the run took is a primary figure, not a wide-viewport
            bonus — it stays visible at every breakpoint (#1046). */}
        {isLive ? (
          <ElapsedDuration startedAt={run.started_at!} />
        ) : (
          finalDuration && (
            <span className="text-muted-foreground font-mono text-xs">{finalDuration}</span>
          )
        )}
        {!isDetail && <span className="text-muted-foreground text-xs">{date}</span>}
        {isDetail && (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t("run.detailsPanel")}
              >
                <ChevronDown />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-3">
              <RunRowDetails run={run} />
            </PopoverContent>
          </Popover>
        )}
      </div>
    </div>
  );

  const className = cn(
    "flex items-center gap-2 px-3 py-3 text-sm transition-colors sm:py-2",
    !isDetail && "hover:bg-muted/50",
  );

  if (isDetail || isOrphaned) {
    return <div className={className}>{content}</div>;
  }

  return (
    <Link
      className={className}
      to={`/agents/${run.packageId}/runs/${run.id}`}
      state={{ runNumber: run.runNumber }}
    >
      {content}
    </Link>
  );
}
