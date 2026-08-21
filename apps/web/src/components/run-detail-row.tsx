// SPDX-License-Identifier: Apache-2.0

/**
 * The strip pinned under the run-detail page header.
 *
 * It used to be the same component as the list row, under a `variant` prop,
 * back when the list was a flex line. The list is a table now (`runs-table.tsx`)
 * and a table row cannot be a strip, so the two parted: what is left here is
 * only the detail side, and every `variant === "list"` branch went with it.
 *
 * What it shows is what the page around it does NOT already say: the status,
 * the badges that explain a missing Re-run button, and how long the run took.
 * The number is the page title, the trigger and the start date belong to the
 * Info tab, the documents to the Documents tab — re-listing them here is the
 * crowding #1046 removed.
 */

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge, MetaBadge } from "./status-badge";
import { RunTokensReadout } from "./run-tokens-readout";
import { RunDuration } from "./run-duration";
import { Button } from "@appstrate/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import type { TokenUsage } from "@appstrate/core/token-usage";
import type { EnrichedRun } from "@appstrate/shared-types";

function DetailLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

/**
 * The panel body behind the chevron.
 *
 * Exported as a testing affordance: the popover keeps its content unmounted
 * until opened, and the web test runner has no DOM to open it with.
 */
export function RunDetailPanel({ run }: { run: EnrichedRun }) {
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
        <DetailLine label={t("run.tabDocuments")}>
          {t("run.detailsDocuments", { input: inputDocs, output: outputDocs })}
        </DetailLine>
      )}
      <DetailLine label={t("run.usageTokensTotal")}>
        <RunTokensReadout usage={run.token_usage as TokenUsage | null} />
      </DetailLine>
    </div>
  );
}

export function RunDetailRow({ run }: { run: EnrichedRun }) {
  const { t } = useTranslation(["agents"]);
  // `packageId == null` on a non-inline run means the source agent was deleted
  // (FK SET NULL): Re-run and the agent-config links are gone, and the badge is
  // what explains their absence.
  const isOrphaned = run.packageId == null && run.package_ephemeral !== true;

  return (
    <div className="flex min-w-0 items-center gap-2 px-3 py-3 text-sm sm:py-2">
      <Badge status={run.status} compact unread={run.unread} />
      {isOrphaned && (
        <MetaBadge label={t("runs.deletedAgentBadge")} title={t("runs.deletedAgentTitle")} italic />
      )}
      {run.runOrigin === "remote" && (
        <MetaBadge label={t("runs.remoteBadge")} title={t("runs.remoteBadgeTitle")} />
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {/* How long the run took is a primary figure, not a wide-viewport
              bonus — it stays visible at every breakpoint (#1046). */}
        <RunDuration status={run.status} startedAt={run.started_at} duration={run.duration} />
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
            <RunDetailPanel run={run} />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
