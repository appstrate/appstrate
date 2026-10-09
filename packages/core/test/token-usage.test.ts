// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { parseTokenUsage } from "@appstrate/afps-shared/token-usage";
import { totalTokens, accumulateTokenUsage, tokenUsageSchema } from "../src/token-usage.ts";

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

describe("tokenUsageSchema", () => {
  it("answers what parseTokenUsage answers", () => {
    for (const raw of [
      { input_tokens: 3, output_tokens: 1, extra: true },
      { input_tokens: 3, tiers: [{ input_tokens_above: 0 }] },
      { input_tokens: 3, tiers: [{ input_tokens_above: 1, output_tokens: 2 }] },
      { input_tokens: 1.5 },
      { output_tokens: -1 },
      null,
      [],
    ]) {
      const parsed = tokenUsageSchema.safeParse(raw);
      expect({ raw, usage: parsed.success ? parsed.data : null }).toEqual({
        raw,
        usage: parseTokenUsage(raw).usage,
      });
    }
  });
});
