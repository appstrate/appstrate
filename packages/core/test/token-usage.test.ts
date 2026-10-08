// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  totalTokens,
  accumulateTokenUsage,
  tokenUsageSchema,
  tokenUsageTiersDropped,
} from "../src/token-usage.ts";

describe("totalTokens", () => {
  it("sums all four buckets", () => {
    expect(
      totalTokens({
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 3_000,
        cache_read_input_tokens: 45_000,
      }),
    ).toBe(48_120);
  });

  it("treats absent optional fields as zero", () => {
    expect(totalTokens({ input_tokens: 100, output_tokens: 20 })).toBe(120);
    expect(totalTokens({ cache_read_input_tokens: 7 })).toBe(7);
    expect(
      totalTokens({
        input_tokens: undefined,
        output_tokens: 5,
        cache_creation_input_tokens: undefined,
        cache_read_input_tokens: undefined,
      }),
    ).toBe(5);
  });

  it("returns 0 for an empty usage record", () => {
    expect(totalTokens({})).toBe(0);
  });

  it("counts the cache buckets a two-bucket sum would omit", () => {
    // `input_tokens` is net of cache, so the cached prompt only shows up in
    // the cache buckets — the regression this helper exists to prevent.
    const usage = {
      input_tokens: 10,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 90_000,
    };
    expect(totalTokens(usage)).toBe(90_020);
    expect(totalTokens(usage)).toBeGreaterThan(
      (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    );
  });

  it("reads back what accumulateTokenUsage wrote", () => {
    const total = {};
    accumulateTokenUsage(total, { input_tokens: 1, cache_read_input_tokens: 2 });
    accumulateTokenUsage(total, { output_tokens: 4, cache_creation_input_tokens: 8 });
    expect(totalTokens(total)).toBe(15);
  });
});

describe("tokenUsageSchema tiers", () => {
  const usage = { input_tokens: 300_000, output_tokens: 1_000 };

  it("accepts one band per threshold", () => {
    const tiers = [
      { input_tokens_above: 200_000, input_tokens: 250_000, output_tokens: 500 },
      { input_tokens_above: 272_000 },
    ];
    expect(tokenUsageSchema.parse({ ...usage, tiers })).toEqual({ ...usage, tiers });
  });

  it("drops malformed bands and keeps the counters", () => {
    const band = { input_tokens_above: 200_000, input_tokens: 1 };
    for (const tiers of [
      [band, band],
      [{ input_tokens_above: 0 }],
      [{ input_tokens_above: 200_000, output_tokens: -1 }],
      [{ ...band, extra: 1 }],
    ]) {
      const raw = { ...usage, tiers };
      const parsed = tokenUsageSchema.parse(raw);
      expect(parsed).toEqual(usage);
      expect(tokenUsageTiersDropped(raw, parsed)).toBe(true);
    }
  });

  it("still rejects a malformed counter", () => {
    expect(tokenUsageSchema.safeParse({ input_tokens: -1 }).success).toBe(false);
  });
});

describe("tokenUsageTiersDropped", () => {
  it("is false when nothing was dropped", () => {
    const tiers = [{ input_tokens_above: 200_000 }];
    expect(tokenUsageTiersDropped({ input_tokens: 1 }, { input_tokens: 1 })).toBe(false);
    expect(tokenUsageTiersDropped({ tiers }, { tiers })).toBe(false);
    expect(tokenUsageTiersDropped({ tiers: "x" }, null)).toBe(false);
  });
});
