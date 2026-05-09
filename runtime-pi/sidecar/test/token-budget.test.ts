// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the token-aware context-budget primitives that the
 * sidecar uses to gate `provider_call` / `run_history` / `recall_memory`
 * tool outputs against the agent's run-level context budget.
 *
 * Coverage focus:
 *   - estimateTokens — chars/3.5 heuristic, edge cases (empty, unicode,
 *     short strings round up).
 *   - readPositiveTokenEnv — fail-loud parsing of env overrides.
 *   - TokenBudget — constructor invariants, decide() purity, record()
 *     accumulation + saturation, run-level cumulative pressure,
 *     tryReserve() atomicity, injected estimator, dev-loud record().
 */

import { describe, it, expect } from "bun:test";
import {
  DEFAULT_INLINE_OUTPUT_TOKENS,
  DEFAULT_RUN_OUTPUT_BUDGET_TOKENS,
  TokenBudget,
  estimateTokens,
  readPositiveTokenEnv,
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

describe("readPositiveTokenEnv", () => {
  const envName = "TEST_TOKEN_BUDGET_ENV_VAR";
  it("returns default when unset", () => {
    delete process.env[envName];
    expect(readPositiveTokenEnv(envName, 1234)).toBe(1234);
  });

  it("returns default when empty string", () => {
    process.env[envName] = "";
    expect(readPositiveTokenEnv(envName, 99)).toBe(99);
    delete process.env[envName];
  });

  it("parses positive integers", () => {
    process.env[envName] = "5000";
    expect(readPositiveTokenEnv(envName, 99)).toBe(5000);
    delete process.env[envName];
  });

  it("throws on non-integer", () => {
    process.env[envName] = "5.5";
    expect(() => readPositiveTokenEnv(envName, 1)).toThrow(/positive integer/);
    delete process.env[envName];
  });

  it("throws on zero / negative", () => {
    for (const v of ["0", "-1", "-100"]) {
      process.env[envName] = v;
      expect(() => readPositiveTokenEnv(envName, 1)).toThrow(/positive integer/);
    }
    delete process.env[envName];
  });

  it("throws on non-numeric", () => {
    process.env[envName] = "not-a-number";
    expect(() => readPositiveTokenEnv(envName, 1)).toThrow(/positive integer/);
    delete process.env[envName];
  });

  it("includes the variable name in the error", () => {
    process.env[envName] = "abc";
    expect(() => readPositiveTokenEnv(envName, 1)).toThrow(envName);
    delete process.env[envName];
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
