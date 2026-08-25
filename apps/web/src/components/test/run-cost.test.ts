// SPDX-License-Identifier: Apache-2.0

/**
 * The run cost readout exists so a run the platform could NOT price stops
 * rendering a confident `$0.0000`. The web test runner has no DOM, so this
 * exercises the pure mapping both surfaces share (`run-cost.ts`), plus source
 * scans proving the header and the Info tab really route through it — a second
 * hand-rolled `toFixed(4)` on either surface is exactly the drift this split
 * was made to prevent.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describeRunCost, COST_UNAVAILABLE } from "../run-cost.ts";

describe("describeRunCost", () => {
  it("unpriced with nothing spent → the placeholder, never a number", () => {
    // The run finalized with `cost = NULL` on purpose; rendering `$0.0000`
    // here would claim the run was free.
    expect(describeRunCost(null, "unpriced")).toEqual({
      text: COST_UNAVAILABLE,
      tooltipKey: "run.costUnpricedTooltip",
    });
    expect(describeRunCost(0, "unpriced").text).toBe(COST_UNAVAILABLE);
  });

  it("unpriced WITH a recorded amount → the amount, flagged as a floor", () => {
    // `computeRunSpend` is worst-of, so one unpriced call among many priced
    // ones makes the whole run `unpriced`. Withholding $12.50 the platform
    // genuinely knows, to avoid overstating the part it doesn't, trades a
    // small overstatement for a total loss of information.
    expect(describeRunCost(12.5, "unpriced")).toEqual({
      text: "$12.5000",
      tooltipKey: "run.costUnpricedFloorTooltip",
    });
  });

  it("partial → the amount, flagged as a floor", () => {
    expect(describeRunCost(0.1234, "partial")).toEqual({
      text: "$0.1234",
      tooltipKey: "run.costPartialTooltip",
    });
  });

  it("priced → today's rendering exactly: bare amount, no tooltip", () => {
    expect(describeRunCost(1.5, "priced")).toEqual({ text: "$1.5000", tooltipKey: null });
  });

  it("no status → identical to priced (the whole back catalogue, not a warning)", () => {
    expect(describeRunCost(0.02, null)).toEqual({ text: "$0.0200", tooltipKey: null });
    expect(describeRunCost(0.02, undefined)).toEqual({ text: "$0.0200", tooltipKey: null });
  });

  it("a status-less null cost still reads $0.0000, unchanged from before", () => {
    // Regression guard: only an unpriced run that spent NOTHING withholds the
    // number. A run that simply spent nothing keeps the zero it always showed.
    expect(describeRunCost(null, null).text).toBe("$0.0000");
    expect(describeRunCost(0, "priced").text).toBe("$0.0000");
  });

  it("qualifies every figure it cannot vouch for", () => {
    // The tooltip key doubles as the "this is a floor" flag, so a qualified
    // amount can never render bare.
    for (const status of ["partial", "unpriced"] as const) {
      expect(describeRunCost(9.99, status).tooltipKey).not.toBeNull();
    }
  });
});

describe("cost readout wiring", () => {
  function read(relative: string): string {
    return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf-8");
  }

  it("the readout component renders through describeRunCost and translates the key", () => {
    const source = read("../run-cost-readout.tsx");
    expect(source).toContain("describeRunCost(cost, pricingStatus)");
    expect(source).toContain("t(tooltipKey)");
    // Keyboard reachability: the trigger is plain text otherwise.
    expect(source).toContain("tabIndex={0}");
  });

  it("both surfaces delegate to the shared readout instead of formatting a cost", () => {
    for (const relative of ["../run-detail/run-header-summary.tsx", "../run-info-tab.tsx"]) {
      const source = read(relative);
      expect(source).toContain("<RunCostReadout");
      expect(source).toContain("pricingStatus={run.cost_pricing_status}");
      expect(source).not.toContain("toFixed(4)");
    }
  });

  it("the live metric patch carries the provenance with the number", () => {
    // Patching `cost` alone would leave a running unpriced run showing the
    // stale status — i.e. a confident $0.0000 for its whole duration.
    const source = read("../../pages/run-detail.tsx");
    expect(source).toContain("cost: metric.costSoFar");
    expect(source).toContain("cost_pricing_status: metric.costPricingStatus");
  });

  it("both locales define every tooltip key the mapping can return", () => {
    // Flat dotted keys: a missing entry renders the raw key string silently.
    const keys = [
      "run.costUnpricedTooltip",
      "run.costUnpricedFloorTooltip",
      "run.costPartialTooltip",
    ];
    for (const locale of ["en", "fr"]) {
      const messages = JSON.parse(read(`../../locales/${locale}/agents.json`)) as Record<
        string,
        string
      >;
      for (const key of keys) {
        expect(messages[key]).toBeTruthy();
      }
    }
  });
});
