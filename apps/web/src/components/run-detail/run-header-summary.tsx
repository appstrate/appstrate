// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Play, Square } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import type { EnrichedRun } from "@appstrate/shared-types";
import { RunDuration } from "../run-duration";
import { getRunTriggerActor, getRunTriggerType } from "../run-trigger";
import { RunCostReadout } from "../run-cost-readout";
import { formatDateField } from "../../lib/markdown";

export function RunHeaderSummary({ run }: { run: EnrichedRun }) {
  const { t } = useTranslation("agents");
  const triggerType = getRunTriggerType(run);
  const triggerActor = getRunTriggerActor(run);

  return (
    <div
      className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pb-2 text-sm"
      data-run-header-summary
    >
      <MetadataItem
        label={t("run.headerTrigger")}
        value={
          triggerActor
            ? t("run.headerTriggerBy", {
                trigger: t(`run.triggerType.${triggerType}`),
                actor: triggerActor,
              })
            : t(`run.triggerType.${triggerType}`)
        }
      />
      <MetadataItem
        separated
        label={t("run.infoStartedAt")}
        value={run.started_at ? formatDateField(run.started_at, "datetime") : t("run.unknownValue")}
      />
      {(run.cost != null || run.cost_pricing_status != null) && (
        <MetadataItem
          separated
          label={t("run.usageCost")}
          value={<RunCostReadout cost={run.cost} pricingStatus={run.cost_pricing_status} />}
        />
      )}
      <MetadataItem
        separated
        label={t("run.infoDuration")}
        value={
          <RunDuration
            status={run.status}
            startedAt={run.started_at}
            duration={run.duration}
            className="font-sans text-sm"
          />
        }
      />
    </div>
  );
}

export function RunHeaderActions({
  canRerun,
  canCancel,
  rerunPending,
  cancelPending,
  onRerun,
  onCancel,
}: {
  canRerun: boolean;
  canCancel: boolean;
  rerunPending: boolean;
  cancelPending: boolean;
  onRerun: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("agents");

  return (
    <div className="flex items-center gap-2">
      {canRerun && (
        <Button
          variant="outline"
          size="sm"
          className="bg-card"
          onClick={onRerun}
          disabled={rerunPending}
        >
          <Play className="text-primary size-3.5" />
          {t("run.rerun")}
        </Button>
      )}
      {canCancel && (
        <Button
          variant="outline"
          size="sm"
          className="bg-card"
          onClick={onCancel}
          disabled={cancelPending}
        >
          <Square className="text-destructive size-3.5" />
          {t("btn.cancel")}
        </Button>
      )}
    </div>
  );
}

function MetadataItem({
  label,
  value,
  separated = false,
}: {
  label: string;
  value: React.ReactNode;
  separated?: boolean;
}) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1">
      {separated && (
        <span className="text-border mr-1" aria-hidden>
          ·
        </span>
      )}
      <span className="text-foreground font-semibold">{label} :</span>
      <span className="text-muted-foreground min-w-0 font-normal">{value}</span>
    </span>
  );
}
