// SPDX-License-Identifier: Apache-2.0

/**
 * CUTOVER SAFETY — the server-computed runner cost must equal what the agent
 * container used to report.
 *
 * The `source="runner"` ledger row's `cost_usd` is no longer the `cost` the Pi
 * container sends on `appstrate.metric`; the platform recomputes it from the
 * kickoff rate snapshot `runs.model_cost` and the reported cumulative token
 * counters (`resolveRunnerCost` in `run-launcher/appstrate-event-sink.ts`, which
 * delegates to the shared `computeTokenCost`). Both sides multiply the SAME
 * rates — `MODEL_COST` is `JSON.stringify(runs.model_cost)` — so the two numbers
 * must agree, or the change silently re-prices every platform run.
 *
 * Same shape as `llm-proxy-usage-parity.test.ts`, one layer up: that file pins
 * the two token NORMALISATIONS together, this one pins the two COST formulas.
 * `piReference` is a literal transcription of pi-ai's `calculateCost`,
 * `libraryFormulaUnchanged` fails if the installed library stops matching it,
 * and both preconditions that make the transcription's two simplifications valid
 * (no volume tiers, no 1h cache writes) are asserted rather than assumed.
 */

import { describe, it, expect } from "bun:test";
import { computeTokenCost, type TokenCost } from "@appstrate/afps-runtime/runner";
import { modelCostSchema } from "@appstrate/core/module";
import type { TokenUsage } from "@appstrate/shared-types";

/** Pi's own four counters, as `installSessionBridge` reads them off the SDK. */
interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * pi-ai's `calculateCost`, transcribed from
 * `node_modules/@earendil-works/pi-ai/dist/models.js`:
 *
 *   const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
 *   let rates = model.cost;
 *   let matchedThreshold = -1;
 *   for (const tier of model.cost.tiers ?? []) { ... }
 *   const longWrite = usage.cacheWrite1h ?? 0;
 *   const shortWrite = usage.cacheWrite - longWrite;
 *   usage.cost.input = (rates.input / 1000000) * usage.input;
 *   usage.cost.output = (rates.output / 1000000) * usage.output;
 *   usage.cost.cacheRead = (rates.cacheRead / 1000000) * usage.cacheRead;
 *   usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000;
 *   usage.cost.total = input + output + cacheRead + cacheWrite;
 *
 * Two branches are dropped, each pinned by its own test below: `tiers` (the
 * platform's `ModelCost` cannot carry them, so `model.cost.tiers` is always
 * `undefined` in the container) and `cacheWrite1h` (only ever non-zero under
 * Anthropic long cache retention, which the platform never requests).
 *
 * The container reaches this function through `runtime-pi`'s `parseModelCost`,
 * which defaults an absent `cacheRead`/`cacheWrite` to `0` — the same value
 * `computeTokenCost` substitutes with `?? 0`, which is why an incompletely
 * priced model stays at parity too.
 */
function piReference(usage: PiUsage, rates: Required<TokenCost>): number {
  const input = (rates.input / 1_000_000) * usage.input;
  const output = (rates.output / 1_000_000) * usage.output;
  const cacheRead = (rates.cacheRead / 1_000_000) * usage.cacheRead;
  const cacheWrite = (rates.cacheWrite * usage.cacheWrite) / 1_000_000;
  return input + output + cacheRead + cacheWrite;
}

/**
 * The platform's snake_case projection of the same counters — exactly the
 * mapping `installSessionBridge` performs before emitting `appstrate.metric`
 * (`input → input_tokens`, `cacheWrite → cache_creation_input_tokens`, …).
 */
function toReportedUsage(usage: PiUsage): TokenUsage {
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read_input_tokens: usage.cacheRead,
    cache_creation_input_tokens: usage.cacheWrite,
  };
}

const cases: { name: string; usage: PiUsage; rates: Required<TokenCost> }[] = [
  {
    name: "Claude-class rates, all four buckets carrying tokens",
    usage: { input: 1_000_000, output: 200_000, cacheRead: 500_000, cacheWrite: 100_000 },
    rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    name: "no cache traffic at all",
    usage: { input: 12_345, output: 6_789, cacheRead: 0, cacheWrite: 0 },
    rates: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2.5 },
  },
  {
    name: "cache-heavy turn (reads dominate)",
    usage: { input: 900, output: 4_100, cacheRead: 3_800_000, cacheWrite: 42_000 },
    rates: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },
  {
    name: "sub-cent totals — the common case, and the one float noise shows up in",
    usage: { input: 431, output: 97, cacheRead: 2_048, cacheWrite: 512 },
    rates: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0.35 },
  },
  {
    name: "model priced for input/output only (absent cache rates default to 0 on both sides)",
    usage: { input: 50_000, output: 10_000, cacheRead: 20_000, cacheWrite: 5_000 },
    rates: { input: 1.25, output: 5, cacheRead: 0, cacheWrite: 0 },
  },
];

describe("runner cost parity: server recompute vs pi-ai calculateCost (container)", () => {
  for (const { name, usage, rates } of cases) {
    it(`agrees to within float noise — ${name}`, () => {
      const server = computeTokenCost(toReportedUsage(usage), rates);
      const container = piReference(usage, rates);
      // 12 decimal places, not `toBe`. The two sides sum the same four products
      // but associate each one differently — `(tokens × rate) / 1e6` here vs
      // `(rate / 1e6) × tokens` in the library — which can differ in the last
      // representable bit (it does for the partial-rate case below). The
      // tolerance is deliberately six orders of magnitude TIGHTER than the
      // production divergence epsilon (1e-6 USD, `appstrate-event-sink.ts`), so
      // it can only absorb float noise and never a formula change.
      expect(server).toBeCloseTo(container, 12);
    });
  }

  it("an absent cache rate prices those tokens at zero on both sides", () => {
    // The container's `parseModelCost` substitutes 0 for a missing key before
    // `calculateCost` ever runs; `computeTokenCost` substitutes it with `?? 0`.
    // Divergence here would mean an incompletely priced model changes price at
    // the cutover — the exact population `pricing_status='partial'` marks.
    const usage: PiUsage = { input: 1_000, output: 500, cacheRead: 9_000, cacheWrite: 3_000 };
    const partial: TokenCost = { input: 3, output: 15 };
    expect(computeTokenCost(toReportedUsage(usage), partial)).toBeCloseTo(
      piReference(usage, { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }),
      12,
    );
  });

  it("`ModelCost` structurally cannot carry volume tiers", () => {
    // Precondition for dropping the tier loop from `piReference`. `MODEL_COST`
    // is `JSON.stringify(runs.model_cost)`, and `runs.model_cost` is read back
    // through `modelCostSchema`, which knows only the four rate keys — so a
    // tiered price list cannot reach either side. If tiers are ever added to
    // the model catalog, the container would re-price and the server would not:
    // this test is where that must be noticed.
    const parsed = modelCostSchema.parse({
      input: 3,
      output: 15,
      tiers: [{ inputTokensAbove: 200_000, input: 6, output: 22.5 }],
    });
    expect(parsed).toEqual({ input: 3, output: 15 });
  });

  it("the platform never requests Anthropic long cache retention", async () => {
    // Precondition for dropping `cacheWrite1h` from `piReference`. pi-ai only
    // sets the `ttl: "1h"` cache_control — and therefore only ever reports
    // `cacheWrite1h > 0`, priced at 2× the INPUT rate rather than the
    // cache-write rate — when cache retention resolves to "long", which needs
    // either an explicit option or `PI_CACHE_RETENTION=long` in the container
    // env. The platform sets neither, so all cache-creation tokens are short
    // writes and the two formulas price them identically. Turning long
    // retention on would reopen a real divergence.
    const containerEnv = await Bun.file(
      new URL("../../../../packages/runner-pi/src/container-env.ts", import.meta.url),
    ).text();
    expect(containerEnv).not.toContain("PI_CACHE_RETENTION");
  });

  it("library formula unchanged — the transcription above still matches node_modules", async () => {
    // Anchors `piReference` to the installed library, exactly as
    // `llm-proxy-usage-parity.test.ts` anchors its own transcription: a pi-ai
    // upgrade that re-prices any bucket fails HERE (re-read the source,
    // re-transcribe, re-check the recompute) instead of silently making the
    // server's authoritative number the wrong one.
    const source = await Bun.file(
      new URL("../../../../node_modules/@earendil-works/pi-ai/dist/models.js", import.meta.url),
    ).text();
    const normalizedSource = source.replace(/\s+/g, " ");

    expect(normalizedSource).toContain("usage.cost.input = (rates.input / 1000000) * usage.input;");
    expect(normalizedSource).toContain(
      "usage.cost.output = (rates.output / 1000000) * usage.output;",
    );
    expect(normalizedSource).toContain(
      "usage.cost.cacheRead = (rates.cacheRead / 1000000) * usage.cacheRead;",
    );
    expect(normalizedSource).toContain(
      "usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000;",
    );
    // The two branches `piReference` drops, pinned by their source text so a
    // library change that makes either reachable by default is caught here.
    expect(normalizedSource).toContain("for (const tier of model.cost.tiers ?? [])");
    expect(normalizedSource).toContain("const longWrite = usage.cacheWrite1h ?? 0;");
  });
});
