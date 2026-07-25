// SPDX-License-Identifier: Apache-2.0

/**
 * Token-bucket PARITY between the two normalisations of the same upstream reply.
 *
 * The identical provider response is parsed twice in this product:
 *
 *   - by the platform proxy adapter (`llm-proxy/openai.ts`), for remote runs and
 *     chat's ai-sdk path — the result is priced by `computeTokenCost` and
 *     written to `llm_usage`;
 *   - by `@mariozechner/pi-ai` (`dist/providers/openai-completions.js`,
 *     `parseChunkUsage`), for every platform-side Pi run — the result is priced
 *     by the SAME `computeTokenCost` and reaches `llm_usage` through the
 *     `appstrate.metric` side channel.
 *
 * The four buckets are billed at four different rates, so any disagreement means
 * the same consumption costs a different amount depending on WHERE the run
 * executed. This file pins the two together: `piAiReference` is a literal
 * transcription of the library's formula, `libraryFormulaUnchanged` fails if the
 * installed library stops matching that transcription, and every case is
 * asserted against both.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { openaiCompletionsAdapter } from "../../src/services/llm-proxy/openai.ts";
import { computeCostUsd } from "../../src/services/llm-proxy/metering.ts";

/** The four disjoint buckets, in the platform's own vocabulary. */
interface Buckets {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * pi-ai's `parseChunkUsage`, transcribed from
 * `node_modules/@mariozechner/pi-ai/dist/providers/openai-completions.js:795-818`:
 *
 *   const promptTokens = rawUsage.prompt_tokens || 0;
 *   const reportedCachedTokens = rawUsage.prompt_tokens_details?.cached_tokens
 *     ?? rawUsage.prompt_cache_hit_tokens ?? 0;
 *   const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
 *   const cacheReadTokens = cacheWriteTokens > 0
 *     ? Math.max(0, reportedCachedTokens - cacheWriteTokens) : reportedCachedTokens;
 *   const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
 *   const outputTokens = rawUsage.completion_tokens || 0;
 */
function piAiReference(raw: Record<string, unknown>): Buckets {
  const details = (raw["prompt_tokens_details"] ?? undefined) as
    Record<string, number | undefined> | undefined;
  const promptTokens = (raw["prompt_tokens"] as number | undefined) || 0;
  const reportedCachedTokens =
    details?.cached_tokens ?? (raw["prompt_cache_hit_tokens"] as number | undefined) ?? 0;
  const cacheWriteTokens = details?.cache_write_tokens || 0;
  const cacheReadTokens =
    cacheWriteTokens > 0
      ? Math.max(0, reportedCachedTokens - cacheWriteTokens)
      : reportedCachedTokens;
  const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
  return {
    input,
    output: (raw["completion_tokens"] as number | undefined) || 0,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
  };
}

/** Platform adapter output, projected onto the same four buckets. */
function platformBuckets(raw: Record<string, unknown>): Buckets {
  const usage = openaiCompletionsAdapter.parseJsonUsage({ usage: raw });
  if (!usage) throw new Error("adapter returned no usage for a usage-bearing payload");
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
  };
}

const cases: { name: string; usage: Record<string, unknown> }[] = [
  {
    name: "plain OpenAI (no cache fields)",
    usage: { prompt_tokens: 1200, completion_tokens: 300 },
  },
  {
    name: "OpenAI prompt caching (nested cached_tokens ⊂ prompt_tokens)",
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 300,
      prompt_tokens_details: { cached_tokens: 1024 },
    },
  },
  {
    name: "DeepSeek (top-level prompt_cache_hit_tokens)",
    usage: {
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
      prompt_cache_hit_tokens: 800_000,
      prompt_cache_miss_tokens: 200_000,
    },
  },
  {
    name: "provider reporting cache writes (OpenRouter dialect)",
    usage: {
      prompt_tokens: 10_000,
      completion_tokens: 500,
      prompt_tokens_details: { cached_tokens: 6_000, cache_write_tokens: 4_000 },
    },
  },
  {
    name: "both cache dialects present at once",
    usage: {
      prompt_tokens: 900,
      completion_tokens: 100,
      prompt_cache_hit_tokens: 400,
      prompt_tokens_details: { cached_tokens: 250, cache_write_tokens: 50 },
    },
  },
  {
    name: "cache write with no reported cache hits",
    usage: {
      prompt_tokens: 5_000,
      completion_tokens: 10,
      prompt_tokens_details: { cache_write_tokens: 2_000 },
    },
  },
];

describe("openai-compatible usage parity: platform proxy vs pi-ai (runner)", () => {
  for (const { name, usage } of cases) {
    it(`agrees on all four buckets — ${name}`, () => {
      expect(platformBuckets(usage)).toEqual(piAiReference(usage));
    });
  }

  it("never double-counts cache reads inside input", () => {
    for (const { usage } of cases) {
      const b = platformBuckets(usage);
      const prompt = (usage["prompt_tokens"] as number | undefined) ?? 0;
      // The three prompt-side buckets partition `prompt_tokens` exactly (no
      // token counted twice, none dropped) for every dialect.
      expect(b.input + b.cacheRead + b.cacheWrite).toBe(prompt);
    }
  });

  it("prices cache writes at the cache-write rate, not the cache-read rate", () => {
    // The money statement of the divergence. GPT-4.1-class rates: input $2/M,
    // cacheRead $0.5/M (0.25×), cacheWrite $2.5/M (1.25×). 4M written tokens.
    const usage = {
      prompt_tokens: 10_000_000,
      completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 6_000_000, cache_write_tokens: 4_000_000 },
    };
    const cost = { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2.5 };
    const parsed = openaiCompletionsAdapter.parseJsonUsage({ usage })!;

    // cacheRead = 6M − 4M = 2M; input = 10M − 2M − 4M = 4M.
    // 4M×2 + 2M×0.5 + 4M×2.5 = 8 + 1 + 10 = 19.
    expect(computeCostUsd(parsed, cost)).toBeCloseTo(19, 9);

    // Pre-fix behaviour: `cache_write_tokens` unread → the 4M written tokens
    // stayed in the cacheRead bucket (6M×0.5) and input was prompt − 6M.
    // 4M×2 + 6M×0.5 = 8 + 3 = 11.
    const preFix = computeCostUsd(
      { inputTokens: 4_000_000, outputTokens: 0, cacheReadTokens: 6_000_000 },
      cost,
    );
    expect(preFix).toBeCloseTo(11, 9);
    // Same consumption, $8 more per 10M prompt tokens — the gap this parity
    // test exists to prevent. On the write bucket alone: 4M billed at 2.5 $/M
    // instead of 0.5 $/M, a 5× under-charge.
    expect(computeCostUsd(parsed, cost)).toBeGreaterThan(preFix);
  });

  it("library formula unchanged — the transcription above still matches node_modules", () => {
    // Anchors `piAiReference` to the installed library: a pi-ai upgrade that
    // rewrites the normalisation fails HERE (re-read the source, re-transcribe,
    // re-check the adapter) instead of silently reopening the divergence.
    const source = readFileSync(
      new URL(
        "../../../../node_modules/@mariozechner/pi-ai/dist/providers/openai-completions.js",
        import.meta.url,
      ),
      "utf8",
    ).replace(/\s+/g, " ");

    expect(source).toContain(
      "rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? 0",
    );
    expect(source).toContain("rawUsage.prompt_tokens_details?.cache_write_tokens || 0");
    expect(source).toContain(
      "cacheWriteTokens > 0 ? Math.max(0, reportedCachedTokens - cacheWriteTokens) : reportedCachedTokens",
    );
    expect(source).toContain("Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens)");
  });
});
