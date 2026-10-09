// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { MAX_TOKEN_USAGE_TIERS } from "@appstrate/afps-shared/token-usage";
import { modelCostSchema } from "../src/module.ts";

const tier = { inputTokensAbove: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite: 0 };

describe("modelCostSchema", () => {
  it("keeps request-wide price tiers", () => {
    const cost = { input: 5, output: 30, cacheRead: 0.5, tiers: [tier] };
    expect(modelCostSchema.parse(cost)).toEqual(cost);
  });

  it("refuses a tier threshold that is not a positive integer token count", () => {
    for (const inputTokensAbove of [0, -1, 1.5]) {
      const cost = { input: 5, output: 30, tiers: [{ ...tier, inputTokensAbove }] };
      expect(modelCostSchema.safeParse(cost).success).toBe(false);
    }
  });

  it("refuses a tier with a negative or missing rate", () => {
    const { cacheWrite: _omitted, ...partial } = tier;
    for (const bad of [{ ...tier, output: -1 }, partial]) {
      expect(modelCostSchema.safeParse({ input: 5, output: 30, tiers: [bad] }).success).toBe(false);
    }
  });

  it("refuses duplicate thresholds and more tiers than a usage may carry bands", () => {
    const tiers = Array.from({ length: MAX_TOKEN_USAGE_TIERS }, (_, i) => ({
      ...tier,
      inputTokensAbove: i + 1,
    }));
    expect(modelCostSchema.safeParse({ input: 5, output: 30, tiers }).success).toBe(true);
    for (const bad of [
      [tier, tier],
      [...tiers, { ...tier, inputTokensAbove: 999_999 }],
    ]) {
      expect(modelCostSchema.safeParse({ input: 5, output: 30, tiers: bad }).success).toBe(false);
    }
  });
});
