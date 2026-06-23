// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { computeTokenCost } from "../../src/runner/token-cost.ts";

describe("computeTokenCost", () => {
  it("returns 0 when no cost rates are supplied", () => {
    expect(
      computeTokenCost(
        {
          input_tokens: 1000,
          output_tokens: 1000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        null,
      ),
    ).toBe(0);
    expect(computeTokenCost({ input_tokens: 5 }, undefined)).toBe(0);
  });

  it("sums input + output + cacheRead + cacheWrite per-million", () => {
    const cost = computeTokenCost(
      {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
      },
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    );
    expect(cost).toBeCloseTo(3 + 15 + 0.3 + 3.75, 10);
  });

  it("treats absent token counts and cache rates as zero", () => {
    // Only input/output present, no cache rates → just input+output cost.
    const cost = computeTokenCost(
      { input_tokens: 1_000_000, output_tokens: 0 },
      { input: 5, output: 10 },
    );
    expect(cost).toBeCloseTo(5, 10);
  });

  it("prorates fractional token counts", () => {
    const cost = computeTokenCost(
      { input_tokens: 500_000, output_tokens: 250_000 },
      { input: 2, output: 8 },
    );
    // 0.5M*2 + 0.25M*8 = 1 + 2 = 3
    expect(cost).toBeCloseTo(3, 10);
  });
});
