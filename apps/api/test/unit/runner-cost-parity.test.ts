// SPDX-License-Identifier: Apache-2.0

/**
 * Hand-computed prices for each ledger path (docs/architecture/RUN_COST.md):
 * a proxy row per request with tiers, a runner row at the base rate, and the
 * container's per-request figures summing to that runner row.
 */

import { describe, it, expect } from "bun:test";
import { modelCostSchema } from "@appstrate/core/module";
import { piTokenCostUsd } from "@appstrate/runner-pi/pi-model";
import { computeCostUsd } from "../../src/services/llm-proxy/metering.ts";
import { aggregatedCostUsd } from "../../src/services/token-cost.ts";
import { parseRuntimeEnv, buildPiModelFromEnv } from "../../../../runtime-pi/env.ts";
// The real projection `installSessionBridge` applies to Pi's counters.
import { toReportedUsage } from "../../../../packages/runner-pi/src/pi-runner.ts";

/** USD per 1M tokens; every rate distinct so a swapped bucket changes the price. */
const COST = {
  input: 5,
  output: 30,
  cacheRead: 0.5,
  cacheWrite: 6.25,
  tiers: [{ inputTokensAbove: 272_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 }],
};
/** 11 100 input-side tokens: base rate → $0.070625. */
const SMALL = { input: 1_000, output: 2_000, cacheRead: 10_000, cacheWrite: 100 };
/** 274 000 input-side tokens, past the tier: $2.57 per request, $1.36 at the base rate. */
const LARGE = { input: 200_000, output: 10_000, cacheRead: 70_000, cacheWrite: 4_000 };
/** SMALL + LARGE at the base rate. */
const RUN_BASE_USD = 1.430625;

function proxyRow(request: typeof SMALL): number {
  return computeCostUsd(
    {
      inputTokens: request.input,
      outputTokens: request.output,
      cacheReadTokens: request.cacheRead,
      cacheWriteTokens: request.cacheWrite,
    },
    COST,
  );
}

function containerModel() {
  return buildPiModelFromEnv(
    parseRuntimeEnv({
      AGENT_RUN_ID: "run_parity",
      APPSTRATE_SINK_URL: "https://api.example.com/api/runs/run_parity/events",
      APPSTRATE_SINK_FINALIZE_URL: "https://api.example.com/api/runs/run_parity/events/finalize",
      APPSTRATE_SINK_SECRET: "abcdefghijklmnopqrstuvwxyz0123456789",
      MODEL_API: "anthropic-messages",
      MODEL_ID: "claude-sonnet-4-6",
      MODEL_COST: JSON.stringify(COST),
      AGENT_PROMPT: "You are a helpful agent.",
      SIDECAR_URL: "http://sidecar:8080",
      SIDECAR_AUTH_TOKEN: "sidecar-auth-token",
    }),
  );
}

describe("ledger prices", () => {
  it("stores a rate card unchanged, tiers included", () => {
    expect(modelCostSchema.parse(JSON.parse(JSON.stringify(COST)))).toEqual(COST);
  });

  it("proxy row: one request, tier honoured", () => {
    expect(proxyRow(SMALL)).toBeCloseTo(0.070625, 10);
    expect(proxyRow(LARGE)).toBeCloseTo(2.57, 10);
  });

  it("runner row: summed usage at the base rate", () => {
    expect(aggregatedCostUsd(toReportedUsage(LARGE), COST)).toBeCloseTo(1.36, 10);
    const run = {
      input: SMALL.input + LARGE.input,
      output: SMALL.output + LARGE.output,
      cacheRead: SMALL.cacheRead + LARGE.cacheRead,
      cacheWrite: SMALL.cacheWrite + LARGE.cacheWrite,
    };
    expect(aggregatedCostUsd(toReportedUsage(run), COST)).toBeCloseTo(RUN_BASE_USD, 10);
  });

  it("container: its per-request figures sum to the runner row, even past a tier", () => {
    const model = containerModel();
    const container = [SMALL, LARGE].reduce((total, r) => total + piTokenCostUsd(model.cost, r), 0);
    expect(container).toBeCloseTo(RUN_BASE_USD, 10);
  });

  it("the container's model record refuses long cache retention", () => {
    // The ledger has no `cacheWrite1h` rate; pi-ai sends `ttl: "1h"` unless the
    // record refuses it (`model-compat.ts`).
    expect(containerModel().compat).toMatchObject({ supportsLongCacheRetention: false });
  });
});
