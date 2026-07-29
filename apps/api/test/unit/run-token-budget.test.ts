// SPDX-License-Identifier: Apache-2.0

/**
 * `deriveRunContextBudget` — the single derivation site for the context-gauge
 * denominator persisted on `runs.context_window` / `runs.compaction_threshold`
 * (#1046).
 *
 * The load-bearing property is the DB invariant these values must satisfy:
 * `0 < compaction_threshold < context_window`. The `runs` CHECK constraints
 * enforce it, which means a derivation that breaks it does not produce a bad
 * gauge — it fails run creation outright. Every case below asserts the
 * invariant, not just the arithmetic.
 */

import { describe, it, expect } from "bun:test";
import { deriveRunContextBudget } from "../../src/services/run-token-budget.ts";
import { DEFAULT_CONTEXT_WINDOW, deriveResponseReserveTokens } from "@appstrate/core/token-budget";

/** The CHECK constraints on `runs`, restated as a test assertion. */
function expectWithinDbInvariant(budget: { contextWindow: number; compactionThreshold: number }) {
  expect(budget.contextWindow).toBeGreaterThan(0);
  expect(budget.compactionThreshold).toBeGreaterThan(0);
  expect(budget.compactionThreshold).toBeLessThan(budget.contextWindow);
  expect(Number.isInteger(budget.contextWindow)).toBe(true);
  expect(Number.isInteger(budget.compactionThreshold)).toBe(true);
}

describe("deriveRunContextBudget", () => {
  it("honours an explicit contextWindow/maxTokens pair", () => {
    const budget = deriveRunContextBudget({ contextWindow: 200_000, maxTokens: 64_000 });
    expect(budget.contextWindow).toBe(200_000);
    // 64k is a usable cap (< window) → reserved verbatim.
    expect(budget.compactionThreshold).toBe(136_000);
    expectWithinDbInvariant(budget);
  });

  it("falls back to the shared DEFAULT_CONTEXT_WINDOW when the model declares none", () => {
    const budget = deriveRunContextBudget({ contextWindow: null, maxTokens: 64_000 });
    expect(budget.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(budget.compactionThreshold).toBe(DEFAULT_CONTEXT_WINDOW - 64_000);
    expectWithinDbInvariant(budget);
  });

  it("falls back for an absent model config entirely (both fields unset)", () => {
    const budget = deriveRunContextBudget({});
    expect(budget.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    // No usable cap → the derived 20% reserve.
    expect(budget.compactionThreshold).toBe(DEFAULT_CONTEXT_WINDOW - 40_000);
    expectWithinDbInvariant(budget);
  });

  it("survives a corrupt maxTokens >= contextWindow instead of yielding a threshold <= 0", () => {
    // Known upstream catalog bug (LiteLLM #22478): max_output_tokens reported
    // equal to the window. Verbatim honouring would give threshold 0.
    const equal = deriveRunContextBudget({ contextWindow: 128_000, maxTokens: 128_000 });
    expect(equal.contextWindow).toBe(128_000);
    expectWithinDbInvariant(equal);

    // And a cap ABOVE the window, which would give a negative threshold.
    const over = deriveRunContextBudget({ contextWindow: 128_000, maxTokens: 200_000 });
    expect(over.contextWindow).toBe(128_000);
    expectWithinDbInvariant(over);

    // The clamp is core's, not a second implementation here.
    expect(over.compactionThreshold).toBe(128_000 - deriveResponseReserveTokens(128_000, 200_000));
  });

  it("treats a non-positive or non-finite contextWindow as unset", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const budget = deriveRunContextBudget({ contextWindow: bad, maxTokens: 4_096 });
      expect(budget.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
      expectWithinDbInvariant(budget);
    }
  });

  it("keeps the invariant across the whole catalog range, including tiny windows", () => {
    for (const contextWindow of [1_024, 8_192, 32_768, 128_000, 200_000, 1_000_000, 2_000_000]) {
      for (const maxTokens of [
        null,
        undefined,
        1,
        4_096,
        64_000,
        contextWindow,
        contextWindow * 2,
      ]) {
        expectWithinDbInvariant(deriveRunContextBudget({ contextWindow, maxTokens }));
      }
    }
  });

  it("matches the runner's compaction sizing for the same model input", () => {
    // Parity with `derivePiCompactionSettings` (packages/runner-pi): both read
    // `deriveResponseReserveTokens`, so `contextWindow - reserveTokens` — the
    // point at which the Pi SDK compacts — is exactly what we persist.
    const model = { contextWindow: 200_000, maxTokens: 16_384 };
    const budget = deriveRunContextBudget(model);
    const reserve = deriveResponseReserveTokens(model.contextWindow, model.maxTokens);
    expect(budget.compactionThreshold).toBe(model.contextWindow - reserve);
  });
});
