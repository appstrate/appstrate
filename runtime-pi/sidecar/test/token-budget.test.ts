// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the token-aware context-budget primitives that the
 * sidecar uses to gate `provider_call` / `run_history` / `recall_memory`
 * tool outputs against the agent's run-level context budget.
 *
 * Coverage focus:
 *   - estimateTokens — chars/3.5 heuristic, edge cases (empty, unicode,
 *     short strings round up).
 *   - TokenBudget — constructor invariants, decide() purity, record()
 *     accumulation + saturation, run-level cumulative pressure,
 *     tryReserve() atomicity, injected estimator, dev-loud record().
 */

import { describe, it, expect } from "bun:test";
import {
  DEFAULT_INLINE_OUTPUT_TOKENS,
  DEFAULT_RUN_OUTPUT_BUDGET_TOKENS,
  TokenBudget,
  deriveBudgetDefaults,
  estimateTokens,
  estimatorForApiShape,
  type TokenEstimator,
} from "../token-budget.ts";

describe("estimateTokens", () => {
  it("returns 0 for the empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("rounds up so any non-empty string costs at least 1 token", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("ab")).toBe(1);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(2); // 4 / 3.5 = 1.14 → ceil → 2
  });

  it("matches the Anthropic-recommended 3.5 chars/token ratio for medium inputs", () => {
    // 350 chars should map to 100 tokens.
    expect(estimateTokens("x".repeat(350))).toBe(100);
    // 700 chars should map to 200 tokens.
    expect(estimateTokens("y".repeat(700))).toBe(200);
  });

  it("handles unicode by code-unit length (consistent with String#length)", () => {
    // Surrogate pairs count as 2 UTF-16 code units, which is what the
    // estimator is designed around.
    expect(estimateTokens("😀😀😀😀")).toBe(Math.ceil(8 / 3.5));
  });

  it("is monotonic in input length", () => {
    let last = 0;
    for (const n of [10, 50, 100, 500, 1000, 5000, 50000]) {
      const t = estimateTokens("a".repeat(n));
      expect(t).toBeGreaterThanOrEqual(last);
      last = t;
    }
  });

  it("is deterministic (same input → same output)", () => {
    const s = "lorem ipsum dolor sit amet ".repeat(500);
    expect(estimateTokens(s)).toBe(estimateTokens(s));
  });
});

describe("TokenBudget — construction", () => {
  it("uses sane defaults", () => {
    const b = new TokenBudget();
    expect(b.inlineCapTokens).toBe(DEFAULT_INLINE_OUTPUT_TOKENS);
    expect(b.runBudgetTokens).toBe(DEFAULT_RUN_OUTPUT_BUDGET_TOKENS);
    expect(b.consumedTokens()).toBe(0);
    expect(b.remainingTokens()).toBe(DEFAULT_RUN_OUTPUT_BUDGET_TOKENS);
  });

  it("accepts overrides", () => {
    const b = new TokenBudget({ inlineCapTokens: 100, runBudgetTokens: 1000 });
    expect(b.inlineCapTokens).toBe(100);
    expect(b.runBudgetTokens).toBe(1000);
  });

  it("rejects non-positive inlineCapTokens", () => {
    expect(() => new TokenBudget({ inlineCapTokens: 0, runBudgetTokens: 100 })).toThrow(
      /positive integer/,
    );
    expect(() => new TokenBudget({ inlineCapTokens: -1, runBudgetTokens: 100 })).toThrow(
      /positive integer/,
    );
  });

  it("rejects non-integer inlineCapTokens", () => {
    expect(() => new TokenBudget({ inlineCapTokens: 1.5, runBudgetTokens: 100 })).toThrow(
      /positive integer/,
    );
  });

  it("rejects non-positive runBudgetTokens", () => {
    expect(() => new TokenBudget({ inlineCapTokens: 1, runBudgetTokens: 0 })).toThrow(
      /positive integer/,
    );
  });

  it("rejects inlineCap > runBudget (would never inline)", () => {
    expect(() => new TokenBudget({ inlineCapTokens: 100, runBudgetTokens: 50 })).toThrow(
      /cannot exceed/,
    );
  });

  it("accepts inlineCap === runBudget (single-call run)", () => {
    const b = new TokenBudget({ inlineCapTokens: 100, runBudgetTokens: 100 });
    expect(b.inlineCapTokens).toBe(100);
  });
});

describe("TokenBudget — decide()", () => {
  it("returns inline / under_inline_cap when comfortably under both caps", () => {
    const b = new TokenBudget({ inlineCapTokens: 100, runBudgetTokens: 1000 });
    const d = b.decide(50);
    expect(d.decision).toBe("inline");
    expect(d.reason).toBe("under_inline_cap");
    expect(d.estimatedTokens).toBe(50);
    expect(d.consumedTokens).toBe(0);
    expect(d.runBudgetTokens).toBe(1000);
    expect(d.inlineCapTokens).toBe(100);
  });

  it("returns spill / exceeds_inline_cap when this single call overflows the per-call cap", () => {
    const b = new TokenBudget({ inlineCapTokens: 100, runBudgetTokens: 10000 });
    const d = b.decide(150);
    expect(d.decision).toBe("spill");
    expect(d.reason).toBe("exceeds_inline_cap");
  });

  it("returns spill / exceeds_run_budget when cumulative overflow happens", () => {
    const b = new TokenBudget({ inlineCapTokens: 100, runBudgetTokens: 200 });
    b.record(150); // consumed = 150, remaining = 50
    const d = b.decide(60); // 150 + 60 = 210 > 200
    expect(d.decision).toBe("spill");
    expect(d.reason).toBe("exceeds_run_budget");
  });

  it("inline-cap check takes priority over run-budget check", () => {
    // If a call simultaneously exceeds both caps, we report the
    // inline-cap reason — it is the more actionable signal (the
    // agent learns "this single call was too big" rather than
    // "the run is full").
    const b = new TokenBudget({ inlineCapTokens: 100, runBudgetTokens: 200 });
    b.record(150);
    const d = b.decide(120); // 120 > inlineCap AND 150+120 > runBudget
    expect(d.reason).toBe("exceeds_inline_cap");
  });

  it("calls equal to the inline cap are inlined", () => {
    const b = new TokenBudget({ inlineCapTokens: 100, runBudgetTokens: 1000 });
    const d = b.decide(100);
    expect(d.decision).toBe("inline");
  });

  it("does NOT mutate state — decide() is pure", () => {
    const b = new TokenBudget({ inlineCapTokens: 100, runBudgetTokens: 1000 });
    b.decide(80);
    b.decide(80);
    b.decide(80);
    expect(b.consumedTokens()).toBe(0);
  });
});

describe("TokenBudget — tryReserve() atomicity", () => {
  it("records on inline so subsequent calls see the updated consumed count", () => {
    const b = new TokenBudget({ inlineCapTokens: 100, runBudgetTokens: 100 });
    const first = b.tryReserve(80);
    expect(first.decision).toBe("inline");
    expect(first.consumedTokens).toBe(80); // post-record snapshot
    expect(b.consumedTokens()).toBe(80);

    // Without atomic record, the second call would still see consumed=0
    // and decide inline; with atomic record it sees 80 and spills.
    const second = b.tryReserve(80);
    expect(second.decision).toBe("spill");
    expect(second.reason).toBe("exceeds_run_budget");
    expect(b.consumedTokens()).toBe(80); // spill did NOT record
  });

  it("does not record on spill (per-call cap exceeded)", () => {
    const b = new TokenBudget({ inlineCapTokens: 100, runBudgetTokens: 1000 });
    b.tryReserve(150);
    expect(b.consumedTokens()).toBe(0);
  });

  it("does not record on spill (run budget exhausted)", () => {
    const b = new TokenBudget({ inlineCapTokens: 100, runBudgetTokens: 100 });
    b.tryReserve(80); // inline → consumed = 80
    const d = b.tryReserve(80); // 80+80 > 100 → spill
    expect(d.decision).toBe("spill");
    expect(b.consumedTokens()).toBe(80); // unchanged
  });

  it("preserves the same reason union as decide()", () => {
    const b = new TokenBudget({ inlineCapTokens: 100, runBudgetTokens: 1000 });
    const d = b.tryReserve(50);
    expect(d.reason).toBe("under_inline_cap");
  });
});

describe("TokenBudget — record() + accumulation", () => {
  it("accumulates over multiple calls", () => {
    const b = new TokenBudget({ inlineCapTokens: 100, runBudgetTokens: 1000 });
    b.record(50);
    b.record(50);
    expect(b.consumedTokens()).toBe(100);
    expect(b.remainingTokens()).toBe(900);
  });

  it("rounds up fractional inputs (defence-in-depth — caller should pass integers)", () => {
    const b = new TokenBudget({ inlineCapTokens: 100, runBudgetTokens: 1000 });
    b.record(2.3);
    expect(b.consumedTokens()).toBe(3);
  });

  it("saturates at runBudgetTokens (never reports negative remaining)", () => {
    const b = new TokenBudget({ inlineCapTokens: 100, runBudgetTokens: 200 });
    b.record(150);
    b.record(150); // would be 300; saturates at 200
    expect(b.consumedTokens()).toBe(200);
    expect(b.remainingTokens()).toBe(0);
  });

  it("throws in non-production on invalid input (catches caller bugs)", () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const b = new TokenBudget({ inlineCapTokens: 100, runBudgetTokens: 1000 });
      expect(() => b.record(0)).toThrow(/positive finite/);
      expect(() => b.record(-50)).toThrow(/positive finite/);
      expect(() => b.record(NaN)).toThrow(/positive finite/);
      expect(() => b.record(Infinity)).toThrow(/positive finite/);
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });

  it("silently ignores invalid input in production (defence-in-depth)", () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const b = new TokenBudget({ inlineCapTokens: 100, runBudgetTokens: 1000 });
      b.record(0);
      b.record(-50);
      b.record(NaN);
      b.record(Infinity);
      expect(b.consumedTokens()).toBe(0);
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });

  it("models the issue #390 scenario: 50 small calls accumulate budget pressure", () => {
    // 50 × 30 KB JSON ≈ 50 × 9000 tokens (30000 chars / 3.5) = 450 K
    // tokens. With a 200 K-token budget the tracker should hit
    // exhaustion long before the 50th call.
    const inlineCap = 10_000; // raise above 9000 so per-call doesn't trigger
    const runBudget = 200_000;
    const b = new TokenBudget({ inlineCapTokens: inlineCap, runBudgetTokens: runBudget });
    const perCall = estimateTokens("x".repeat(30_000)); // ≈ 8572 tokens
    let inlineCount = 0;
    let spillCount = 0;
    for (let i = 0; i < 50; i++) {
      const d = b.tryReserve(perCall);
      if (d.decision === "inline") inlineCount++;
      else spillCount++;
    }
    // Around 200_000 / 8572 ≈ 23 calls fit before run-budget triggers.
    expect(inlineCount).toBeLessThan(50);
    expect(spillCount).toBeGreaterThan(0);
    expect(b.consumedTokens()).toBeLessThanOrEqual(runBudget);
  });
});

describe("TokenBudget — pluggable estimator", () => {
  it("uses the default heuristic when no estimator is injected", () => {
    const b = new TokenBudget();
    expect(b.estimate("x".repeat(350))).toBe(100);
  });

  it("uses the injected estimator for estimate() and budget decisions", () => {
    // Mock tokenizer that always returns 5 — operators wiring a real
    // tokenizer get the same code path.
    const fakeEstimator: TokenEstimator = () => 5;
    const b = new TokenBudget({
      inlineCapTokens: 10,
      runBudgetTokens: 100,
      estimate: fakeEstimator,
    });
    expect(b.estimate("anything")).toBe(5);
    expect(b.estimate("a".repeat(100_000))).toBe(5);
  });

  it("the injected estimator drives spill decisions in tryReserve()", () => {
    // Estimator overstates so even short text spills.
    const overEstimator: TokenEstimator = () => 999_999;
    const b = new TokenBudget({
      inlineCapTokens: 1_000,
      runBudgetTokens: 10_000,
      estimate: overEstimator,
    });
    const d = b.tryReserve(b.estimate("hi"));
    expect(d.decision).toBe("spill");
    expect(d.reason).toBe("exceeds_inline_cap");
  });
});

describe("TokenBudget — defaults reflect SOTA expectations", () => {
  it("DEFAULT_INLINE_OUTPUT_TOKENS is around 1 LLM-targeted page (8K)", () => {
    expect(DEFAULT_INLINE_OUTPUT_TOKENS).toBeGreaterThanOrEqual(4_000);
    expect(DEFAULT_INLINE_OUTPUT_TOKENS).toBeLessThanOrEqual(16_000);
  });

  it("DEFAULT_RUN_OUTPUT_BUDGET_TOKENS covers a Claude-default-context run", () => {
    // Default budgets stay conservative for the 200 K-token context
    // window. Operators on 1 M Sonnet 4.6 can raise via env var.
    expect(DEFAULT_RUN_OUTPUT_BUDGET_TOKENS).toBeGreaterThanOrEqual(100_000);
  });

  it("inline cap is materially smaller than run budget (otherwise no cumulative gate)", () => {
    expect(DEFAULT_INLINE_OUTPUT_TOKENS).toBeLessThan(DEFAULT_RUN_OUTPUT_BUDGET_TOKENS);
  });
});

describe("TokenBudget — context-window guard (#464)", () => {
  it("defaults to no window guard when contextWindowTokens is unset", () => {
    const b = new TokenBudget({ inlineCapTokens: 10_000, runBudgetTokens: 1_000_000 });
    expect(b.contextWindowTokens).toBeNull();
    expect(b.reserveTokens).toBe(0);
    const d = b.decide(8_000);
    expect(d.decision).toBe("inline");
    expect(d.contextWindowTokens).toBeNull();
  });

  it("derives a conservative reserve when only contextWindowTokens is set", () => {
    // 200 K context → reserve = max(16384, 200000 × 0.2) = 40 000
    const b = new TokenBudget({
      inlineCapTokens: 10_000,
      runBudgetTokens: 500_000,
      contextWindowTokens: 200_000,
    });
    expect(b.contextWindowTokens).toBe(200_000);
    expect(b.reserveTokens).toBe(40_000);
  });

  it("honors explicit reserveTokens (mirrors the model's maxTokens)", () => {
    const b = new TokenBudget({
      inlineCapTokens: 10_000,
      runBudgetTokens: 500_000,
      contextWindowTokens: 200_000,
      reserveTokens: 64_000, // Claude Haiku 4.5 maxTokens
    });
    expect(b.reserveTokens).toBe(64_000);
  });

  it("spills with exceeds_context_window when cumulative + estimated would breach window − reserve", () => {
    // 200 K window, 64 K reserve → threshold = 136 K. Run-budget set
    // high enough (500 K) that only the context-window guard fires.
    const b = new TokenBudget({
      inlineCapTokens: 10_000,
      runBudgetTokens: 500_000,
      contextWindowTokens: 200_000,
      reserveTokens: 64_000,
    });
    // Pump in 14 × 9750 tokens ≈ 136.5 K, still under threshold.
    for (let i = 0; i < 13; i++) {
      const d = b.tryReserve(9_750);
      expect(d.decision).toBe("inline");
    }
    // 13 × 9750 = 126 750. Next 9750 → 136 500 > 136 000 threshold.
    const overflow = b.tryReserve(9_750);
    expect(overflow.decision).toBe("spill");
    expect(overflow.reason).toBe("exceeds_context_window");
    expect(overflow.contextWindowTokens).toBe(200_000);
    expect(overflow.reserveTokens).toBe(64_000);
  });

  it("models the issue #464 scenario: 10 parallel 7.5 K-token tool_results spill the late ones", () => {
    // Haiku 4.5 — 200 K window, 64 K reserve. 10 calls × 7500 tokens
    // each (the issue's repro) total 75 K — fits under the inline cap
    // (8 K is too tight, but raising to 10 K reflects an operator
    // setup willing to inline medium responses). The legacy run-budget
    // is permissive (100 K) — without the window guard, all 10 would
    // inline and the 11th LLM call would 400.
    const b = new TokenBudget({
      inlineCapTokens: 10_000,
      runBudgetTokens: 200_000,
      contextWindowTokens: 200_000,
      reserveTokens: 64_000,
    });
    const perCall = 7_500;
    let inline = 0;
    let windowSpills = 0;
    const TOTAL = 20;
    for (let i = 0; i < TOTAL; i++) {
      const d = b.tryReserve(perCall);
      if (d.decision === "inline") {
        inline++;
      } else if (d.reason === "exceeds_context_window") {
        windowSpills++;
      }
    }
    // Threshold = 200 K − 64 K = 136 K. 18 calls × 7500 = 135 K fits;
    // the 19th would push to 142.5 K and spills. The guard kicks in
    // BEFORE the upstream hard limit, leaving room for the model
    // response — exactly the failure mode #464 describes.
    expect(windowSpills).toBeGreaterThan(0);
    expect(inline + windowSpills).toBe(TOTAL);
    expect(inline).toBeLessThanOrEqual(18);
  });

  it("inline-cap check still takes priority over the context-window check", () => {
    const b = new TokenBudget({
      inlineCapTokens: 100,
      runBudgetTokens: 500_000,
      contextWindowTokens: 200_000,
      reserveTokens: 64_000,
    });
    // Single call > inline cap AND would also breach the window.
    b.record(150_000); // saturate near threshold
    const d = b.decide(200); // > inlineCap
    expect(d.reason).toBe("exceeds_inline_cap");
  });

  it("context-window check fires before run-budget check (window is the load-bearing limit)", () => {
    // Window threshold (136 K) lower than run budget (200 K). A call
    // pushing past both should surface the window reason — the
    // actionable signal is the imminent upstream 400.
    const b = new TokenBudget({
      inlineCapTokens: 10_000,
      runBudgetTokens: 200_000,
      contextWindowTokens: 200_000,
      reserveTokens: 64_000,
    });
    b.record(130_000); // close to the 136 K threshold
    const d = b.decide(8_000); // 130 K + 8 K = 138 K > 136 K, < 200 K
    expect(d.decision).toBe("spill");
    expect(d.reason).toBe("exceeds_context_window");
  });

  it("rejects contextWindowTokens that is not a positive integer", () => {
    expect(
      () =>
        new TokenBudget({
          inlineCapTokens: 100,
          runBudgetTokens: 1_000,
          contextWindowTokens: 0,
        }),
    ).toThrow(/positive integer/);
    expect(
      () =>
        new TokenBudget({
          inlineCapTokens: 100,
          runBudgetTokens: 1_000,
          contextWindowTokens: 1.5,
        }),
    ).toThrow(/positive integer/);
  });

  it("rejects reserveTokens supplied without contextWindowTokens", () => {
    expect(
      () =>
        new TokenBudget({
          inlineCapTokens: 100,
          runBudgetTokens: 1_000,
          reserveTokens: 50,
        }),
    ).toThrow(/contextWindowTokens/);
  });

  it("rejects reserveTokens ≥ contextWindowTokens (would leave zero room for tools)", () => {
    expect(
      () =>
        new TokenBudget({
          inlineCapTokens: 100,
          runBudgetTokens: 1_000,
          contextWindowTokens: 1_000,
          reserveTokens: 1_000,
        }),
    ).toThrow(/strictly less than/);
  });
});

describe("deriveBudgetDefaults", () => {
  it("returns the legacy hand-tuned constants when contextWindow is unknown", () => {
    expect(deriveBudgetDefaults(undefined)).toEqual({
      inlineCapTokens: DEFAULT_INLINE_OUTPUT_TOKENS,
      runBudgetTokens: DEFAULT_RUN_OUTPUT_BUDGET_TOKENS,
    });
  });

  it("matches the legacy 8K / 100K pair exactly on Sonnet 200K (rétro-compat invariant)", () => {
    // Calibration target: the chosen fractions (4 %, 50 %) must produce
    // the exact pre-model-aware defaults on the model both were tuned
    // against. Breaking this invariant silently regresses every Sonnet
    // run.
    expect(deriveBudgetDefaults(200_000)).toEqual({
      inlineCapTokens: 8_000,
      runBudgetTokens: 100_000,
    });
  });

  it("clamps the inline cap floor when scaling from a tiny context window", () => {
    // 4 % × 32K = 1280 — below the 4K floor.
    expect(deriveBudgetDefaults(32_000)).toEqual({
      inlineCapTokens: 4_000,
      runBudgetTokens: 50_000, // 50% × 32K = 16K, raised to floor 50K
    });
  });

  it("scales linearly through the mid-range (Sonnet 400K / GPT-5)", () => {
    expect(deriveBudgetDefaults(400_000)).toEqual({
      inlineCapTokens: 16_000,
      runBudgetTokens: 200_000,
    });
  });

  it("clamps both caps at their ceilings on Gemini 1M", () => {
    expect(deriveBudgetDefaults(1_000_000)).toEqual({
      inlineCapTokens: 32_000, // 4 % × 1M = 40K → clamped to 32K
      runBudgetTokens: 500_000, // 50 % × 1M = 500K → at ceiling
    });
  });

  it("stays at the ceilings on Gemini 2M (no overshoot)", () => {
    expect(deriveBudgetDefaults(2_000_000)).toEqual({
      inlineCapTokens: 32_000,
      runBudgetTokens: 500_000,
    });
  });
});

describe("estimatorForApiShape", () => {
  it("falls back to the legacy 3.5 chars/token estimator when apiShape is undefined", () => {
    const estimator = estimatorForApiShape(undefined);
    // Same numerical contract as `estimateTokens` — verifying via identity
    // is brittle, so we check observable behaviour on a known input.
    expect(estimator("x".repeat(350))).toBe(100);
  });

  it("uses 3.2 chars/token for anthropic-messages", () => {
    const estimator = estimatorForApiShape("anthropic-messages");
    expect(estimator("x".repeat(320))).toBe(100);
  });

  it("uses 3.4 chars/token for the OpenAI family", () => {
    const expected = Math.ceil(1000 / 3.4);
    expect(estimatorForApiShape("openai-chat")("x".repeat(1000))).toBe(expected);
    expect(estimatorForApiShape("openai-completions")("x".repeat(1000))).toBe(expected);
    expect(estimatorForApiShape("openai-responses")("x".repeat(1000))).toBe(expected);
    expect(estimatorForApiShape("openai-codex-responses")("x".repeat(1000))).toBe(expected);
    expect(estimatorForApiShape("azure-openai-responses")("x".repeat(1000))).toBe(expected);
  });

  it("uses 2.8 chars/token for the Google family (densest tokenizer)", () => {
    const expected = Math.ceil(1000 / 2.8);
    expect(estimatorForApiShape("google-generative-ai")("x".repeat(1000))).toBe(expected);
    expect(estimatorForApiShape("google-vertex")("x".repeat(1000))).toBe(expected);
  });

  it("returns higher token counts for Google than for Anthropic on identical input", () => {
    // Sanity check on the bias direction — Gemini's denser tokenizer
    // should always count more tokens for the same byte payload.
    const payload = "x".repeat(10_000);
    const google = estimatorForApiShape("google-generative-ai")(payload);
    const anthropic = estimatorForApiShape("anthropic-messages")(payload);
    expect(google).toBeGreaterThan(anthropic);
  });

  it("falls back to 3.0 chars/token for unknown apiShape (conservative)", () => {
    const estimator = estimatorForApiShape("acme-rocket-protocol");
    expect(estimator("x".repeat(300))).toBe(100);
  });

  it("returns 0 tokens for empty input regardless of apiShape", () => {
    for (const shape of [
      undefined,
      "anthropic-messages",
      "openai-chat",
      "google-generative-ai",
      "unknown-shape",
    ]) {
      expect(estimatorForApiShape(shape)("")).toBe(0);
    }
  });
});
