// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";
import { totalTokens, type TokenUsage } from "@appstrate/core/token-usage";

/**
 * A run's token consumption: the total, with the four-bucket breakdown behind a
 * tooltip.
 *
 * Lifted out of the run-detail header (#1046) so the run row's details panel can
 * render it. A shared component rather than a render slot on `RunRow`: the panel
 * needs `runs.token_usage` and `RunRow` already receives the whole run DTO, so
 * threading markup down from the page would be plumbing that buys nothing — and
 * it is the same seam `RunCostReadout` already uses for the `$` beside it.
 *
 * Its own file despite the single caller: it is `RunCostReadout`'s twin (same
 * directory, same props-in/tooltip-out shape), and inlining ~35 lines of
 * four-bucket tooltip into `run-row.tsx` would bury the row's own structure.
 *
 * The count goes through `totalTokens` so it covers the same four buckets the
 * cost prices — `input_tokens` is net of cache, so an input+output sum would
 * omit the bulk of the consumption on any cached run and contradict the Info tab.
 *
 * ABSENT vs ZERO are not the same fact and are not rendered the same way.
 * `runs.token_usage` is `null` on a run that failed before it ever reached the
 * model, and `totalTokens({})` would turn that into a confident `0` with a
 * four-zero tooltip — "consumed nothing" where the truth is "never measured".
 * An em dash, matching the rule `RunCostReadout` and the per-turn latency column
 * already follow. A measured zero still prints `0`, tooltip and all.
 */
export function RunTokensReadout({ usage }: { usage: TokenUsage | null | undefined }) {
  const { t } = useTranslation("agents");
  if (usage == null) return <span className="tabular-nums">—</span>;
  const total = totalTokens(usage);

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        {/* Focusable trigger: the readout is otherwise plain text, so keyboard
            users would have no way to reach the breakdown. */}
        <TooltipTrigger asChild>
          <span tabIndex={0} className="cursor-default tabular-nums underline decoration-dotted">
            {total.toLocaleString()}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <span className="block text-xs">
            {t("run.usageInputTokens")}: {(usage.input_tokens ?? 0).toLocaleString()}
          </span>
          <span className="block text-xs">
            {t("run.usageOutputTokens")}: {(usage.output_tokens ?? 0).toLocaleString()}
          </span>
          <span className="block text-xs">
            {t("run.usageCacheRead")}: {(usage.cache_read_input_tokens ?? 0).toLocaleString()}
          </span>
          <span className="block text-xs">
            {t("run.usageCacheCreation")}:{" "}
            {(usage.cache_creation_input_tokens ?? 0).toLocaleString()}
          </span>
          <span className="text-muted-foreground mt-1 block text-xs">
            {t("run.usageTokensCumulative")}
          </span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
