// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { isTokenUsageTiers } from "../src/token-usage.ts";

describe("isTokenUsageTiers", () => {
  it("accepts bands with distinct positive thresholds and non-negative counters", () => {
    expect(isTokenUsageTiers([])).toBe(true);
    expect(
      isTokenUsageTiers([
        { input_tokens_above: 100_000, input_tokens: 5, cache_read_input_tokens: 0 },
        { input_tokens_above: 272_000 },
      ]),
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
      [{ input_tokens_above: Number.POSITIVE_INFINITY }],
      [{ input_tokens_above: 1 }, { input_tokens_above: 1 }],
      [{ input_tokens_above: 1, output_tokens: -1 }],
      [{ input_tokens_above: 1, cache_creation_input_tokens: null }],
      [{ input_tokens_above: 1, input_tokens: Number.NaN }],
    ]) {
      expect({ value, verdict: isTokenUsageTiers(value) }).toEqual({ value, verdict: false });
    }
  });
});
