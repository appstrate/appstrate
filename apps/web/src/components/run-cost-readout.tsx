// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";
import { cn } from "@appstrate/ui/cn";
import { COST_UNAVAILABLE, describeRunCost, type RunPricingStatus } from "./run-cost";

interface RunCostReadoutProps {
  /** `runs.cost` — the ledger aggregate. */
  cost: number | null | undefined;
  /** `runs.cost_pricing_status` — what that aggregate is worth. */
  pricingStatus: RunPricingStatus | null | undefined;
  /** Extra classes for the amount itself (the two call sites style it differently). */
  className?: string;
}

/**
 * The run cost, rendered with whatever caveat its pricing provenance calls for.
 * Both surfaces that display a run's cost go through this, so the run header
 * and the Exécution pane's Usage card (`run-execution-tab.tsx`) can never
 * disagree about the same run.
 *
 * A `priced` (or status-less) run renders exactly as it always did: bare text,
 * no tooltip, no interactive affordance. The tooltip only appears when there is
 * something to explain — otherwise every run would grow a dotted underline
 * saying "this number is fine".
 */
export function RunCostReadout({ cost, pricingStatus, className }: RunCostReadoutProps) {
  const { t } = useTranslation("agents");
  const { text, tooltipKey } = describeRunCost(cost, pricingStatus);

  if (!tooltipKey) return <span className={className}>{text}</span>;

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        {/* Focusable trigger: the readout is otherwise plain text, so keyboard
            users would have no way to reach the explanation — which is the only
            place the caveat is stated. */}
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className={cn("cursor-default underline decoration-dotted", className)}
          >
            {text}
            {/* Visible marker so the caveat survives without hover/focus — a
                tooltip alone would let a floor figure read as exact. The
                placeholder is already its own signal and takes no marker. */}
            {text !== COST_UNAVAILABLE && <span aria-hidden>*</span>}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <span className="block text-xs">{t(tooltipKey)}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
