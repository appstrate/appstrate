// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { modelCostSchema } from "../src/module.ts";

const tier = { inputTokensAbove: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite: 0 };

describe("modelCostSchema", () => {
  it("keeps request-wide price tiers", () => {
    const cost = { input: 5, output: 30, cacheRead: 0.5, tiers: [tier] };
    expect(modelCostSchema.parse(cost)).toEqual(cost);
  });

  it("refuses a tier threshold that is not a positive token count", () => {
    for (const inputTokensAbove of [0, -1]) {
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
});
