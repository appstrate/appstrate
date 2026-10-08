// SPDX-License-Identifier: Apache-2.0

/**
 * Hand-computed prices for each ledger path (docs/architecture/RUN_COST.md),
 * on a tiered rate card: a proxy row per request and the runner row from the
 * summed usage and its tier bands — the same dollars. The container's own sum
 * of its per-request figures is `packages/runner-pi/test/session-bridge.test.ts`'s.
 */

import { describe, it, expect } from "bun:test";
import { modelCostSchema } from "@appstrate/core/module";
import { piTokenCostUsd, type PiTokenCounts } from "@appstrate/runner-pi/pi-model";
import { computeCostUsd } from "../../src/services/llm-proxy/metering.ts";
import { cumulativeCostUsd } from "../../src/services/token-cost.ts";
import { parseRuntimeEnv, buildPiModelFromEnv } from "../../../../runtime-pi/env.ts";
// The real accumulator the container runs on Pi's counters.
import { installSessionBridge } from "../../../../packages/runner-pi/src/pi-runner.ts";

/** USD per 1M tokens, a Haiku-class card; every rate distinct, so a swapped bucket shows. */
const COST = {
  input: 0.1,
  output: 0.5,
  cacheRead: 0.01,
  cacheWrite: 0.125,
  tiers: [
    { inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  ],
};

/** A run's requests, each with its input-side total and hand-computed price. */
const REQUESTS: { request: PiTokenCounts; usd: number }[] = [
  // 50 000: base. 200 + 500 + 400 + 1 000 micro-dollars.
  { request: { input: 2_000, output: 1_000, cacheRead: 40_000, cacheWrite: 8_000 }, usd: 0.0021 },
  // 128 000: tier. 2 500 + 5 000 + 6 000 + 1 875.
  {
    request: { input: 5_000, output: 2_000, cacheRead: 120_000, cacheWrite: 3_000 },
    usd: 0.015375,
  },
  // 100 000 exactly: a tier applies strictly ABOVE its threshold, so base. 100 + 250 + 12 375.
  { request: { input: 1_000, output: 500, cacheRead: 0, cacheWrite: 99_000 }, usd: 0.012725 },
  // 300 000: tier. 150 000 + 10 000.
  { request: { input: 300_000, output: 4_000, cacheRead: 0, cacheWrite: 0 }, usd: 0.16 },
];
const RUN_USD = 0.1902;
/** The same run at the base rate — what a sum without its bands would price at. */
const RUN_BASE_USD = 0.0499;

function containerModel() {
  return buildPiModelFromEnv(
    parseRuntimeEnv({
      AGENT_RUN_ID: "run_parity",
      APPSTRATE_SINK_URL: "https://api.example.com/api/runs/run_parity/events",
      APPSTRATE_SINK_FINALIZE_URL: "https://api.example.com/api/runs/run_parity/events/finalize",
      APPSTRATE_SINK_SECRET: "abcdefghijklmnopqrstuvwxyz0123456789",
      MODEL_API: "anthropic-messages",
      MODEL_ID: "claude-haiku-5-5",
      MODEL_COST: JSON.stringify(COST),
      MODEL_CONTEXT_WINDOW: "1000000",
      AGENT_PROMPT: "You are a helpful agent.",
      SIDECAR_URL: "http://sidecar:8080",
      SIDECAR_AUTH_TOKEN: "sidecar-auth-token",
      MODEL_BASE_URL: "http://sidecar:8080/llm",
      MODEL_API_KEY: "sk-placeholder",
    }),
  );
}

/** The container's session: each turn carries Pi's `calculateCost` on the container model. */
function runContainerSession() {
  const model = containerModel();
  const messages: unknown[] = [];
  let listener: (event: unknown) => void = () => {};
  const bridge = installSessionBridge(
    { state: { messages }, subscribe: (cb) => (listener = cb) },
    { emit: async () => {} },
    "run_parity",
    { cost: model.cost },
  );
  for (const { request } of REQUESTS) {
    const cost = { total: piTokenCostUsd(model.cost, request) };
    messages.push({ role: "assistant", usage: { ...request, cost }, content: [] });
    listener({ type: "message_end" });
  }
  return bridge;
}

describe("ledger prices", () => {
  it("stores a rate card unchanged, tiers included", () => {
    expect(modelCostSchema.parse(JSON.parse(JSON.stringify(COST)))).toEqual(COST);
    expect(containerModel().cost).toEqual(COST);
  });

  it("proxy row: one request, tier honoured", () => {
    for (const { request, usd } of REQUESTS) {
      const row = computeCostUsd(
        {
          inputTokens: request.input,
          outputTokens: request.output,
          cacheReadTokens: request.cacheRead,
          cacheWriteTokens: request.cacheWrite,
        },
        COST,
      );
      expect(row).toBeCloseTo(usd, 10);
    }
  });

  it("runner row: the summed usage carries the tier band, priced at the tier", () => {
    const usage = runContainerSession().getUsage();
    expect(usage.tiers).toEqual([
      {
        input_tokens_above: 100_000,
        input_tokens: 305_000,
        output_tokens: 6_000,
        cache_read_input_tokens: 120_000,
        cache_creation_input_tokens: 3_000,
      },
    ]);
    expect(cumulativeCostUsd(usage, COST)).toBeCloseTo(RUN_USD, 10);
    expect(cumulativeCostUsd({ ...usage, tiers: undefined }, COST)).toBeCloseTo(RUN_BASE_USD, 10);
  });

  it("the container's model record refuses long cache retention", () => {
    // The ledger has no `cacheWrite1h` rate; pi-ai sends `ttl: "1h"` unless the
    // record refuses it (`model-compat.ts`).
    expect(containerModel().compat).toMatchObject({ supportsLongCacheRetention: false });
  });
});
