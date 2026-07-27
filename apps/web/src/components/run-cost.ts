// SPDX-License-Identifier: Apache-2.0

/**
 * Pure logic behind "how do I render a run's cost, given what the platform
 * actually knows about its pricing".
 *
 * Two surfaces show the number — the run header readout and the Info tab's
 * Usage card — and they must agree: a header saying `—` above a card saying
 * `$0.0000` is worse than either alone. This module is the single decision;
 * {@link RunCostReadout} (`run-cost-readout.tsx`) is its only renderer.
 *
 * Split from the component because the web test runner has no DOM: the mapping
 * is the part worth testing, and it is testable only if it does not import the
 * component tree (same split as `model-form/cost-fields.ts`).
 *
 * The rule it enforces: `cost = 0` is not a fact until the ledger says the
 * model HAD rates. `unpriced` means the platform could not price the run at
 * all, so the amount is withheld rather than rounded down to a confident zero;
 * `partial` means part of the consumption was priced at zero for lack of a
 * rate, so the amount shown is a floor and says so.
 */

/** Pricing provenance as carried by the run DTO / the `run_metric` SSE frame. */
export type RunPricingStatus = "priced" | "partial" | "unpriced";

export interface RunCostDisplay {
  /** The value to render — a formatted amount, or the em-dash placeholder. */
  text: string;
  /**
   * `true` when {@link text} is a real amount that is nonetheless incomplete,
   * so the renderer appends its caveat marker. Never `true` alongside the
   * placeholder: there is no figure left to qualify.
   */
  caveat: boolean;
  /**
   * i18n key of the explanation the reader needs, or `null` when the figure
   * stands on its own. Flat dotted key — passed verbatim to `t()`.
   */
  tooltipKey: "run.costUnpricedTooltip" | "run.costPartialTooltip" | null;
}

/** Rendered instead of an amount when nothing could be priced. */
export const COST_UNAVAILABLE = "—";

/**
 * Decide what to show for a run's cost.
 *
 * `null` / absent `pricingStatus` is deliberately treated as `priced`: it means
 * "recorded before this was tracked", and downgrading every historical run to a
 * warning would cry wolf on the entire back catalogue. The reverse mistake —
 * reading `null` as a positive priced claim in an ACCOUNTING context — is what
 * the ledger consumers are warned about; here the stake is one dashboard label.
 */
export function describeRunCost(
  cost: number | null | undefined,
  pricingStatus: RunPricingStatus | null | undefined,
): RunCostDisplay {
  if (pricingStatus === "unpriced") {
    return { text: COST_UNAVAILABLE, caveat: false, tooltipKey: "run.costUnpricedTooltip" };
  }
  // Four decimals: a single cheap call rounds to $0.00 at two, and the readout
  // is the only place a per-run spend is visible.
  const amount = `$${(cost ?? 0).toFixed(4)}`;
  if (pricingStatus === "partial") {
    return { text: amount, caveat: true, tooltipKey: "run.costPartialTooltip" };
  }
  return { text: amount, caveat: false, tooltipKey: null };
}
