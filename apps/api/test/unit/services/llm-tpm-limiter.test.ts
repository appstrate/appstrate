// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the org-scale TPM bucket. Covers:
 *
 *   - draws within budget allow
 *   - draws beyond budget deny with the right `retryAfterSeconds`
 *   - per-(orgId, modelLabel) isolation
 *   - disabled bucket (config absent) returns allow + zero draw
 *   - token-estimation correctness across OpenAI chat-completions and
 *     Anthropic messages shapes (incl. content as `{type, text}[]`)
 *
 * Closes #431 (Path B — Redis-backed limiter via `rate-limiter-flexible`).
 *
 * No DB, no HTTP — the limiter is wired through the in-memory factory by
 * default (tests run on Tier 2 with Redis, but the local `flushRedis()`
 * call between tests gives us identical isolation guarantees). We never
 * mock the limiter itself; the whole point is that the real
 * `RateLimiterRedis` / `RateLimiterMemory` semantics flow through.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import {
  DEFAULT_MAX_TOKENS_RESERVATION,
  _resetTpmLimiterForTesting,
  drawTpm,
} from "../../../src/services/llm-tpm-limiter.ts";
import {
  _resetProxyLimitsForTesting,
  _setProxyLimitsForTesting,
  initProxyLimits,
} from "../../../src/services/proxy-limits.ts";
import { estimateRequestTokens } from "../../../src/services/llm-proxy/helpers.ts";
import { closeRedis, flushRedis } from "../../helpers/redis.ts";

// Each test installs its own bucket config and starts from an empty
// Redis. The reset helpers drop both the limiter cache (so a new bucket
// capacity rebuilds a fresh limiter) and the proxy-limits singleton.
beforeEach(async () => {
  _resetProxyLimitsForTesting();
  _resetTpmLimiterForTesting();
  await flushRedis();
});

afterAll(async () => {
  // Restore the suite-wide defaults so subsequent test files in the same
  // `bun test` process keep seeing a populated proxy-limits singleton.
  _resetProxyLimitsForTesting();
  initProxyLimits();
  await closeRedis();
});

describe("drawTpm — bucket enforcement", () => {
  it("allows draws under the configured TPM ceiling", async () => {
    _setProxyLimitsForTesting({
      tpm_buckets: { default: { tpm: 10_000 } },
    });

    const res = await drawTpm({
      orgId: "org_a",
      modelLabel: "gpt-4o",
      estimatedTokens: 1_000,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      // `default` is the *policy* match — the bucket state itself is keyed
      // on the modelLabel so distinct models never collide on a shared
      // default bucket.
      expect(res.bucketKey).toBe("gpt-4o");
      expect(res.consumed).toBe(1_000);
      expect(res.remaining).toBe(9_000);
    }
  });

  it("denies once the cumulative draw exceeds the ceiling and surfaces retryAfter", async () => {
    _setProxyLimitsForTesting({
      tpm_buckets: { "gpt-4o": { tpm: 5_000 } },
    });

    const first = await drawTpm({
      orgId: "org_a",
      modelLabel: "gpt-4o",
      estimatedTokens: 3_000,
    });
    expect(first.ok).toBe(true);

    const second = await drawTpm({
      orgId: "org_a",
      modelLabel: "gpt-4o",
      estimatedTokens: 3_000,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.bucketKey).toBe("gpt-4o");
      expect(second.capacity).toBe(5_000);
      expect(second.requested).toBe(3_000);
      // 60s fixed window, draw happened ~immediately — Retry-After should
      // be ≤60 and ≥1 (we floor at 1 to never tell clients to retry "now").
      expect(second.retryAfterSeconds).toBeGreaterThan(0);
      expect(second.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it("clamps a single oversized draw to the bucket capacity (cannot wedge the bucket)", async () => {
    _setProxyLimitsForTesting({
      tpm_buckets: { default: { tpm: 1_000 } },
    });

    // Estimate 50× the bucket. The limiter would reject with a tiny
    // `consumedPoints` increment outside our clamp, but the clamp ensures
    // we attempt exactly `capacity` — so the result is a clean deny with
    // `requested` reflecting the agent's actual ask (50_000).
    const res = await drawTpm({
      orgId: "org_a",
      modelLabel: "model-x",
      estimatedTokens: 50_000,
    });

    // The bucket was at zero before this call, so charge=1000 fills it
    // exactly to the ceiling — `consume()` succeeds (consumedPoints == points
    // is the boundary case, `rate-limiter-flexible` resolves it).
    // The next draw must deny.
    expect(res.ok).toBe(true);

    const followup = await drawTpm({
      orgId: "org_a",
      modelLabel: "model-x",
      estimatedTokens: 1,
    });
    expect(followup.ok).toBe(false);
  });

  it("isolates buckets per (orgId, modelLabel) — two orgs drink from separate budgets", async () => {
    _setProxyLimitsForTesting({
      tpm_buckets: { default: { tpm: 2_000 } },
    });

    const orgADraw = await drawTpm({
      orgId: "org_a",
      modelLabel: "gpt-4o",
      estimatedTokens: 2_000,
    });
    expect(orgADraw.ok).toBe(true);

    // Org A's bucket is now empty — but org B's must be untouched.
    const orgBDraw = await drawTpm({
      orgId: "org_b",
      modelLabel: "gpt-4o",
      estimatedTokens: 2_000,
    });
    expect(orgBDraw.ok).toBe(true);

    // Different modelLabel within the same org also gets its own bucket.
    const orgAOtherModel = await drawTpm({
      orgId: "org_a",
      modelLabel: "claude-sonnet-4",
      estimatedTokens: 2_000,
    });
    expect(orgAOtherModel.ok).toBe(true);

    // Org A's gpt-4o bucket should still be exhausted.
    const orgADrawAgain = await drawTpm({
      orgId: "org_a",
      modelLabel: "gpt-4o",
      estimatedTokens: 1,
    });
    expect(orgADrawAgain.ok).toBe(false);
  });

  it("prefers a model-specific entry over the default fallback", async () => {
    _setProxyLimitsForTesting({
      tpm_buckets: {
        default: { tpm: 100_000 },
        "gpt-4o": { tpm: 1_000 },
      },
    });

    // Specific bucket wins → exhausts at 1_000 even though default is 100k.
    const first = await drawTpm({
      orgId: "org_a",
      modelLabel: "gpt-4o",
      estimatedTokens: 1_000,
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.bucketKey).toBe("gpt-4o");

    const second = await drawTpm({
      orgId: "org_a",
      modelLabel: "gpt-4o",
      estimatedTokens: 1,
    });
    expect(second.ok).toBe(false);
  });

  it("returns allow with bucketKey=null when no bucket is configured", async () => {
    _setProxyLimitsForTesting({ tpm_buckets: {} });

    const res = await drawTpm({
      orgId: "org_a",
      modelLabel: "any-model",
      estimatedTokens: 1_000_000,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.bucketKey).toBeNull();
      expect(res.consumed).toBe(0);
      expect(res.remaining).toBeNull();
    }
  });

  it("honours `burst` as the per-call ceiling when set", async () => {
    _setProxyLimitsForTesting({
      tpm_buckets: { default: { tpm: 1_000, burst: 5_000 } },
    });

    // Burst raises the effective capacity to 5_000, so a single 4_000-
    // token draw still fits.
    const res = await drawTpm({
      orgId: "org_a",
      modelLabel: "m",
      estimatedTokens: 4_000,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.remaining).toBe(1_000);
  });
});

describe("estimateRequestTokens — body-shape coverage", () => {
  it("handles OpenAI chat-completions with plain-string content", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: "gpt-4o",
        max_tokens: 200,
        messages: [
          { role: "system", content: "you are helpful" },
          { role: "user", content: "hello world" },
        ],
      }),
    );
    // chars = 15 ("you are helpful") + 11 ("hello world") = 26
    // estimate = ceil(26 / 3.5) + 200 = 8 + 200 = 208
    expect(estimateRequestTokens(body, DEFAULT_MAX_TOKENS_RESERVATION)).toBe(208);
  });

  it("handles OpenAI content-as-array of {type, text} parts", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: "gpt-4o",
        max_tokens: 100,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe this" },
              // Non-text parts (image_url, etc.) are intentionally ignored
              // — token cost is dominated by text in our cheap estimator.
              { type: "image_url", image_url: { url: "https://x/y.png" } },
            ],
          },
        ],
      }),
    );
    // chars = 13 ("describe this")
    // estimate = ceil(13 / 3.5) + 100 = 4 + 100 = 104
    expect(estimateRequestTokens(body, DEFAULT_MAX_TOKENS_RESERVATION)).toBe(104);
  });

  it("handles Anthropic messages with top-level `system` and content array", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: "claude-sonnet",
        max_tokens: 500,
        system: "you are an expert",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "explain quicksort" }],
          },
        ],
      }),
    );
    // chars = 17 ("you are an expert") + 17 ("explain quicksort") = 34
    // estimate = ceil(34 / 3.5) + 500 = 10 + 500 = 510
    expect(estimateRequestTokens(body, DEFAULT_MAX_TOKENS_RESERVATION)).toBe(510);
  });

  it("handles Anthropic system as an array of {type, text} parts", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: "claude-sonnet",
        max_tokens: 50,
        system: [
          { type: "text", text: "rule 1" },
          { type: "text", text: "rule 2" },
        ],
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    // chars = 6 + 6 + 2 = 14
    // estimate = ceil(14 / 3.5) + 50 = 4 + 50 = 54
    expect(estimateRequestTokens(body, DEFAULT_MAX_TOKENS_RESERVATION)).toBe(54);
  });

  it("falls back to defaultMaxTokens when `max_tokens` is absent", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    // chars = 2, estimate = ceil(2/3.5) + 4096 = 1 + 4096 = 4097
    expect(estimateRequestTokens(body, DEFAULT_MAX_TOKENS_RESERVATION)).toBe(4097);
  });

  it("returns defaultMaxTokens for a malformed body without crashing", () => {
    const body = new TextEncoder().encode("not json");
    expect(estimateRequestTokens(body, 4096)).toBe(4096);
  });
});
