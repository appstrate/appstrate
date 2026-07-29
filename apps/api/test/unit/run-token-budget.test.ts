// SPDX-License-Identifier: Apache-2.0

/**
 * `deriveRunContextBudget` — the single derivation site for the context-gauge
 * denominator persisted on `runs.context_window` / `runs.compaction_threshold`
 * (#1046).
 *
 * The load-bearing property is the DB invariant these values must satisfy:
 * `0 < compaction_threshold < context_window`, both integral. The `runs` CHECK
 * constraints enforce it, which means a derivation that breaks it does not
 * produce a bad gauge — it fails run creation outright with an opaque 500.
 * Every case below asserts the invariant, not just the arithmetic, and the
 * matrix deliberately includes the fractional and near-degenerate inputs that
 * `SYSTEM_PROVIDER_KEYS` (`z.number().positive()`, no `.int()`) and
 * `POST /api/models` genuinely admit.
 *
 * The other half of the contract is that the function returns `null` rather
 * than guessing: see the module docblock in `run-token-budget.ts` for why an
 * undeclared window cannot be filled in with core's `DEFAULT_CONTEXT_WINDOW`.
 */

import { describe, it, expect } from "bun:test";
import { deriveRunContextBudget } from "../../src/services/run-token-budget.ts";
import { deriveResponseReserveTokens } from "@appstrate/core/token-budget";

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
    expect(budget).not.toBeNull();
    expect(budget!.contextWindow).toBe(200_000);
    // 64k is a usable cap (< window) → reserved verbatim.
    expect(budget!.compactionThreshold).toBe(136_000);
    expectWithinDbInvariant(budget!);
  });

  it("returns null — NOT a guessed window — when the model declares none", () => {
    // The container falls back to its OWN 128k default (runtime-pi/env.ts) for
    // an omitted MODEL_CONTEXT_WINDOW, which is not core's 200k. Persisting
    // either number would draw a gauge over a denominator the run never used.
    expect(deriveRunContextBudget({ contextWindow: null, maxTokens: 64_000 })).toBeNull();
    expect(deriveRunContextBudget({ contextWindow: undefined })).toBeNull();
    expect(deriveRunContextBudget({})).toBeNull();
  });

  it("survives a corrupt maxTokens >= contextWindow instead of yielding a threshold <= 0", () => {
    // Known upstream catalog bug (LiteLLM #22478): max_output_tokens reported
    // equal to the window. Verbatim honouring would give threshold 0.
    const equal = deriveRunContextBudget({ contextWindow: 128_000, maxTokens: 128_000 });
    expect(equal!.contextWindow).toBe(128_000);
    expectWithinDbInvariant(equal!);

    // And a cap ABOVE the window, which would give a negative threshold.
    const over = deriveRunContextBudget({ contextWindow: 128_000, maxTokens: 200_000 });
    expect(over!.contextWindow).toBe(128_000);
    expectWithinDbInvariant(over!);

    // The clamp is core's, not a second implementation here.
    expect(over!.compactionThreshold).toBe(128_000 - deriveResponseReserveTokens(128_000, 200_000));
  });

  it("returns null for a non-positive, non-finite or sub-2 contextWindow", () => {
    // No pair satisfying `0 < threshold < window` with integral columns exists
    // below a window of 2, and a garbage window is not a window we know. NULL
    // (rendered as "no gauge") beats a row `createRun` cannot insert.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(deriveRunContextBudget({ contextWindow: bad, maxTokens: 4_096 })).toBeNull();
    }
    // 0.5 floors to 0 and 1 leaves no room for a reserve — both previously
    // emitted {0, -1} and {1, 0}, rows BOTH CHECKs reject.
    expect(deriveRunContextBudget({ contextWindow: 0.5 })).toBeNull();
    expect(deriveRunContextBudget({ contextWindow: 1 })).toBeNull();
  });

  it("holds the invariant at the smallest derivable window", () => {
    // 2 is the boundary: the first window for which an integer threshold
    // strictly inside (0, window) exists at all.
    const budget = deriveRunContextBudget({ contextWindow: 2 });
    expect(budget).toEqual({ contextWindow: 2, compactionThreshold: 1 });
    expectWithinDbInvariant(budget!);
  });

  it("floors a fractional contextWindow instead of passing it to an integer column", () => {
    const budget = deriveRunContextBudget({ contextWindow: 8_192.7, maxTokens: 1_024 });
    expect(budget!.contextWindow).toBe(8_192);
    expectWithinDbInvariant(budget!);
  });

  it("keeps the invariant across the whole catalog range, fractions included", () => {
    // `SYSTEM_PROVIDER_KEYS` validates both fields with `z.number().positive()`
    // and NO `.int()`, and `POST /api/models` accepts a contextWindow of 1 —
    // so every value here is genuinely reachable. Each of 1, 2 and 0.5 broke
    // the invariant before the clamp landed.
    for (const contextWindow of [
      0.5, 1, 2, 3, 1_023.5, 1_024, 8_192, 32_768, 128_000, 200_000, 1_000_000, 2_000_000,
    ]) {
      for (const maxTokens of [
        null,
        undefined,
        0.5,
        1,
        1_000.5,
        4_096,
        8_192.5,
        64_000,
        contextWindow,
        contextWindow * 2,
      ]) {
        const budget = deriveRunContextBudget({ contextWindow, maxTokens });
        // null is always a legal answer; a non-null one must be insertable.
        if (budget !== null) expectWithinDbInvariant(budget);
      }
    }
  });

  it("matches the runner's compaction sizing for the same model input", () => {
    // Parity with `derivePiCompactionSettings` (packages/runner-pi): both read
    // `deriveResponseReserveTokens`, so `contextWindow - reserveTokens` — the
    // point at which the Pi SDK compacts — is exactly what we persist. Parity
    // is claimed ONLY for a declared window; with none, the runner applies
    // core's default while the container applies its own, and the platform
    // declines to pick a side by storing NULL.
    const model = { contextWindow: 200_000, maxTokens: 16_384 };
    const budget = deriveRunContextBudget(model);
    const reserve = deriveResponseReserveTokens(model.contextWindow, model.maxTokens);
    expect(budget!.compactionThreshold).toBe(model.contextWindow - reserve);
  });
});
