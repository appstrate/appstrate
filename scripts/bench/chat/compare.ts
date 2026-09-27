#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Compare bench results against the first file (the baseline):
 *
 *   bun run bench:chat:compare base.json fix-a.json fix-b.json [--metrics firstVisible,end]
 *
 * Per scenario and metric: medians, the median delta, and a two-sided
 * Mann-Whitney p-value, so a delta inside the noise is not read as a gain.
 * A metric a scenario does not have (`dots` for `warm-new`) is skipped.
 */

import { parseArgs } from "node:util";
import {
  completed,
  metricsOf,
  metricValue,
  TURN_METRICS,
  UI_METRICS,
  type BenchResult,
} from "./results.ts";
import { mannWhitneyP, quantile } from "./stats.ts";

const { values: opts, positionals: files } = parseArgs({
  allowPositionals: true,
  options: {
    metrics: {
      type: "string",
      default:
        "firstVisible,toUpstream,preamble,mcpHandshake,llmProxyTtfb,end,dots,blank,firstText",
    },
  },
});
if (files.length < 2) {
  throw new Error("usage: compare.ts <baseline.json> <variant.json>... [--metrics a,b]");
}
const metrics = opts.metrics.split(",");
for (const metric of metrics) {
  if (!Object.hasOwn(TURN_METRICS, metric) && !Object.hasOwn(UI_METRICS, metric)) {
    throw new Error(`unknown metric ${metric}`);
  }
}

const [base, ...variants] = (await Promise.all(files.map((f) => Bun.file(f).json()))) as [
  BenchResult,
  ...BenchResult[],
];
const scenarios = [...new Set(base.records.map((r) => r.scenario))];
const values = (result: BenchResult, scenario: string, path: readonly string[]) =>
  completed(result.records, scenario)
    .map((r) => metricValue(r, path))
    .filter((v): v is number => v !== null);
const median = (xs: number[]) =>
  quantile(
    xs.toSorted((a, b) => a - b),
    0.5,
  );
const signed = (v: number) => `${v >= 0 ? "+" : ""}${Math.round(v)}`;

for (const variant of variants) {
  console.log(
    `\n${variant.label} (${variant.gitHead}) vs ${base.label} (${base.gitHead}) — medians ms`,
  );
  for (const scenario of scenarios) {
    const table = metricsOf(scenario);
    const cells = metrics
      .filter((metric) => Object.hasOwn(table, metric))
      .map((metric) => {
        const a = values(base, scenario, table[metric]!);
        const b = values(variant, scenario, table[metric]!);
        if (a.length === 0 || b.length === 0) return `${metric}=—`;
        const ma = median(a);
        const mb = median(b);
        const p = mannWhitneyP(a, b);
        const pct = ma === 0 ? "" : `, ${signed(((mb - ma) / ma) * 100)}%`;
        return `${metric}: ${Math.round(ma)}→${Math.round(mb)} (${signed(mb - ma)}${pct}, p=${p.toFixed(3)}${p < 0.05 ? " *" : ""})`;
      });
    console.log(`  ${scenario.padEnd(10)} ${cells.join("  ")}`);
  }
}
