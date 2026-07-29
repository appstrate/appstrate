// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Shield, FileInput, FileOutput, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "./status-badge";
import { RunTrigger } from "./run-trigger";
import { RunTokensReadout } from "./run-tokens-readout";
import { Button } from "@appstrate/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { cn } from "@appstrate/ui/cn";
import { formatDateField } from "../lib/markdown";
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
export type RunRowVariant = "list" | "detail";

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

/**
 * The three facts the `detail` variant drops from its always-visible line that
 * have nowhere else to live. Deliberately NOT here — the Info tab is their sole
 * owner, and duplicating them was the crowding this pass removes:
 *   - trigger, start date, proxy → `run-info-tab.tsx` (`run.infoTrigger`,
 *     `run.infoStartedAt`, `run.infoProxy`)
 *   - the four token buckets → same tab; only their SUM is here, because that
 *     is the figure #1046 demotes from the header and the tab never shows it
 *   - `#N` → the page title
 * The Documents tab badge shows a total, never the in/out split, so the split
 * stays.
 *
 * Exported as a testing affordance: the popover keeps its content unmounted
 * until opened, and the web test runner has no DOM to open it with.
 */
export function RunRowDetails({ run }: { run: EnrichedRun }) {
  const { t } = useTranslation(["agents"]);
  const inputDocs = run.document_counts.input;
  const outputDocs = run.document_counts.output;

  return (
    <div className="space-y-2">
      {run.package_ephemeral === true && (
        <span className="border-border text-muted-foreground inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">
          {t("runs.inlineBadge")}
        </span>
      )}
      {(inputDocs > 0 || outputDocs > 0) && (
        <DetailRow label={t("run.tabDocuments")}>
          {t("run.detailsDocuments", { input: inputDocs, output: outputDocs })}
        </DetailRow>
      )}
      <DetailRow label={t("run.usageTokensTotal")}>
        <RunTokensReadout usage={run.token_usage as TokenUsage | null} />
      </DetailRow>
    </div>
  );
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

  // Live elapsed timer while running
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isRunning || !run.started_at) return;
    const start = new Date(run.started_at).getTime();
    const tick = () => setElapsed(Date.now() - start);
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [isRunning, run.started_at]);

  const time = isRunning ? elapsed : run.duration;
  const duration = time ? `${(time / 1000).toFixed(1)}s` : "";

  // `document_counts` is a non-optional field of the run DTO — every list and
  // detail endpoint computes it — so read it straight.
  const inputDocs = run.document_counts.input;
  const outputDocs = run.document_counts.output;

  const content = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {/* `#N` duplicates the detail page's own title, so the detail variant
          drops it outright rather than moving it into the panel. */}
      {!isDetail && run.runNumber != null && (
        <span className="text-muted-foreground shrink-0 font-mono text-xs">#{run.runNumber}</span>
      )}
      {agentName && <span className="truncate font-medium">{agentName}</span>}
      <Badge status={run.status} compact unread={isUnread} />
      {!isDetail && isInline && (
        <span className="border-border text-muted-foreground shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">
          {t("runs.inlineBadge")}
        </span>
      )}
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
          page the Info tab already owns all three, so they are dropped outright
          rather than moved into the panel. */}
      {!isDetail && <RunTrigger run={run} />}

      {!isDetail && run.proxy_label && (
        <Shield size={12} className="text-muted-foreground hidden shrink-0 sm:block" />
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {/* Document counts duplicate the Documents tab badge on the detail page. */}
        {!isDetail && inputDocs > 0 && (
          <span
            className="text-muted-foreground flex items-center gap-0.5 text-xs"
            title={t("run.inputDocuments", { count: inputDocs })}
          >
            <FileInput size={12} className="shrink-0" />
            {inputDocs}
          </span>
        )}
        {!isDetail && outputDocs > 0 && (
          <span
            className="text-muted-foreground flex items-center gap-0.5 text-xs"
            title={t("run.outputDocuments", { count: outputDocs })}
          >
            <FileOutput size={12} className="shrink-0" />
            {outputDocs}
          </span>
        )}
        {/* How long the run took is a primary figure, not a wide-viewport
            bonus — it stays visible at every breakpoint (#1046). */}
        {duration && <span className="text-muted-foreground font-mono text-xs">{duration}</span>}
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
