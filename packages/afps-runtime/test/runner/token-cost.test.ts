// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { classifyTokenPricing } from "../../src/runner/token-cost.ts";

describe("classifyTokenPricing", () => {
  it("reports unpriced when no rates exist at all", () => {
    const usage = { input_tokens: 1000, output_tokens: 500 };
    expect(classifyTokenPricing(usage, null)).toBe("unpriced");
    expect(classifyTokenPricing(usage, undefined)).toBe("unpriced");
  });

  it("reports priced when every bucket that carried tokens had a rate", () => {
    expect(
      classifyTokenPricing(
        {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 100,
        },
        { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      ),
    ).toBe("priced");
  });

  it("does not flag a missing cacheRead rate when no cached tokens were reported", () => {
    // No false positives: the overwhelming majority of catalog entries omit cacheRead,
    // and a run that never hit the cache is fully priced by input+output alone.
    expect(
      classifyTokenPricing(
        { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0 },
        { input: 3, output: 15 },
      ),
    ).toBe("priced");
    // Absent field, not just 0.
    expect(classifyTokenPricing({ input_tokens: 1000 }, { input: 3, output: 15 })).toBe("priced");
  });

  it("reports partial when cached tokens were reported but no cacheRead rate exists", () => {
    // Those tokens were already subtracted from the `input` bucket by the normalisation,
    // so at rate 0 they are billed nowhere — a silent undercount, not a free read.
    expect(
      classifyTokenPricing(
        { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 4000 },
        { input: 3, output: 15, cacheWrite: 3.75 },
      ),
    ).toBe("partial");
  });

  it("treats an explicit cacheRead of 0 as a real price, not a missing rate", () => {
    expect(
      classifyTokenPricing(
        { input_tokens: 1000, cache_read_input_tokens: 4000 },
        { input: 3, output: 15, cacheRead: 0 },
      ),
    ).toBe("priced");
  });

  it("does NOT downgrade on a missing cacheWrite rate (deliberate asymmetry)", () => {
    // Pinned on purpose: only 5/89 openai and 0/40 xai catalog entries carry cacheWrite,
    // so flagging on it would mark almost every row `partial` and destroy the signal.
    // If this ever fails, the rule was changed — re-read the JSDoc before "fixing" it.
    expect(
      classifyTokenPricing(
        {
          input_tokens: 1000,
          output_tokens: 500,
          cache_creation_input_tokens: 8000,
          cache_read_input_tokens: 0,
        },
        { input: 3, output: 15, cacheRead: 0.3 },
      ),
    ).toBe("priced");
  });
});
