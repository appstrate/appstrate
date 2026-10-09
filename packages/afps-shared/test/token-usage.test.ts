// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { isTokenCount, isTokenUsageTiers, MAX_TOKEN_USAGE_TIERS } from "../src/token-usage.ts";

describe("isTokenUsageTiers", () => {
  it("accepts bands with distinct positive thresholds and non-negative counters", () => {
    expect(isTokenUsageTiers([])).toBe(true);
    expect(
      isTokenUsageTiers([
        { input_tokens_above: 100_000, input_tokens: 5, cache_read_input_tokens: 0 },
        { input_tokens_above: 200_000, output_tokens: 0.5 },
        { input_tokens_above: 272_000 },
      ]),
    ).toBe(true);
    expect(
      isTokenUsageTiers(
        Array.from({ length: MAX_TOKEN_USAGE_TIERS }, (_, i) => ({ input_tokens_above: i + 1 })),
      ),
    ).toBe(true);
  });

  it("rejects anything else", () => {
    for (const value of [
      undefined,
      {},
      [null],
      [[]],
      [{}],
      [{ input_tokens_above: 0 }],
      [{ input_tokens_above: "1" }],
      [{ input_tokens_above: 1.5 }],
      [{ input_tokens_above: Number.POSITIVE_INFINITY }],
      [{ input_tokens_above: 1 }, { input_tokens_above: 1 }],
      [{ input_tokens_above: 1, output_tokens: -1 }],
      [{ input_tokens_above: 1, output_tokens: Number.POSITIVE_INFINITY }],
      [{ input_tokens_above: 1, cache_creation_input_tokens: null }],
      [{ input_tokens_above: 1, input_tokens: Number.NaN }],
      [{ input_tokens_above: 1, cost: 0.2 }],
      [{ input_tokens_above: 1, tiers: [] }],
      Array.from({ length: MAX_TOKEN_USAGE_TIERS + 1 }, (_, i) => ({ input_tokens_above: i + 1 })),
    ]) {
      expect({ value, verdict: isTokenUsageTiers(value) }).toEqual({ value, verdict: false });
    }
  });
});

describe("isTokenCount", () => {
  it("accepts a finite non-negative number only", () => {
    expect([0, 1, 2.5].every(isTokenCount)).toBe(true);
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined]) {
      expect({ value, verdict: isTokenCount(value) }).toEqual({ value, verdict: false });
    }
  });
});
