// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { FileText, History, Play, Square } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import type { EnrichedRun } from "@appstrate/shared-types";
import { Badge, MetaBadge } from "../status-badge";
import { RunDuration } from "../run-duration";
import { RunTrigger } from "../run-trigger";
import { RunCostReadout } from "../run-cost-readout";
import { formatDateField } from "../../lib/markdown";

export function RunHeaderSummary({
  run,
  isRunning,
  canRerun,
  canCancel,
  rerunPending,
  cancelPending,
  onRerun,
  onCancel,
}: {
  run: EnrichedRun;
  isRunning: boolean;
  canRerun: boolean;
  canCancel: boolean;
  rerunPending: boolean;
  cancelPending: boolean;
  onRerun: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("agents");
  const fileCount = run.document_counts.output;

  return (
    <section className="border-border mb-5 rounded-xl border bg-white p-4 dark:bg-transparent">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge status={run.status} unread={run.unread} />
          {run.package_ephemeral && <MetaBadge label={t("runs.inlineBadge")} />}
          <span className="text-muted-foreground text-sm font-medium">
            {run.version_ref === "draft" ? t("run.draft") : `v${run.version_ref}`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {canRerun && (
            <Button variant="outline" size="sm" onClick={onRerun} disabled={rerunPending}>
              <Play className="size-3.5" />
              {t("run.rerun")}
            </Button>
          )}
          {canCancel && (
            <Button variant="destructive" size="sm" onClick={onCancel} disabled={cancelPending}>
              <Square className="size-3.5" />
              {t("btn.cancel")}
            </Button>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-x-7 gap-y-3 text-sm sm:grid-cols-2 xl:grid-cols-5">
        <Fact
          label={t("run.infoStartedAt")}
          value={
            run.started_at ? formatDateField(run.started_at, "datetime") : t("run.unknownValue")
          }
        />
        <Fact
          label={t("run.infoDuration")}
          value={
            <RunDuration status={run.status} startedAt={run.started_at} duration={run.duration} />
          }
        />
        <Fact label={t("run.infoTrigger")} value={<RunTrigger run={run} />} />
        <Fact
          label={t("run.usageCost")}
          value={
            run.cost != null || run.cost_pricing_status != null ? (
              <RunCostReadout cost={run.cost} pricingStatus={run.cost_pricing_status} />
            ) : (
              t("run.unknownValue")
            )
          }
        />
        <Fact
          label={t("run.resultsProduction")}
          value={
            <span className="inline-flex items-center gap-1.5">
              <FileText className="size-3.5" />
              {t("run.fileCount", { count: fileCount })}
            </span>
          }
        />
      </div>

      {isRunning && (
        <p className="text-primary mt-3 inline-flex items-center gap-2 text-xs font-medium">
          <History className="size-3.5 animate-pulse" />
          {t("run.liveHint")}
        </p>
      )}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground mb-1 text-xs">{label}</p>
      <div className="min-w-0 truncate font-medium" title={typeof value === "string" ? value : ""}>
        {value || "—"}
      </div>
    </div>
  );
}
