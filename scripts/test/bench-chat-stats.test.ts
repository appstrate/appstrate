// SPDX-License-Identifier: Apache-2.0

/**
 * The chat bench's statistics decide whether a latency delta is reported as a
 * gain or as noise, so they are checked against textbook values rather than
 * against themselves.
 */

import { describe, it, expect } from "bun:test";
import { mannWhitneyP, quantile, summarize } from "../bench/chat/stats.ts";

describe("quantile", () => {
  it("interpolates linearly between closest ranks", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 10);
    expect(quantile([10, 20, 30], 0.5)).toBe(20);
    expect(quantile([7], 0.9)).toBe(7);
  });

  it("refuses an empty sample instead of returning NaN", () => {
    expect(() => quantile([], 0.5)).toThrow();
  });
});

describe("summarize", () => {
  it("summarizes the finite values and ignores turns that produced none", () => {
    expect(summarize([4, null, 1, undefined, 3, Number.NaN, 2, Infinity])).toEqual({
      n: 4,
      median: 2.5,
      p90: expect.closeTo(3.7, 10),
      mean: 2.5,
      min: 1,
      max: 4,
    });
  });

  it("is null when no turn produced the metric", () => {
    expect(summarize([null, undefined])).toBeNull();
    expect(summarize([])).toBeNull();
  });
});

describe("mannWhitneyP", () => {
  it("is exact for small tie-free samples", () => {
    // Fully separated samples: the most extreme of C(n1 + n2, n1) orderings, counted on both sides.
    expect(mannWhitneyP([1, 2, 3], [4, 5, 6])).toBeCloseTo(2 / 20, 12);
    expect(mannWhitneyP([1, 2, 3, 4], [5, 6, 7, 8])).toBeCloseTo(2 / 70, 12);
    expect(mannWhitneyP([6, 7, 8, 9, 10], [1, 2, 3, 4, 5])).toBeCloseTo(2 / 252, 12);
    // U = 1 for 3 vs 3: P(U ≤ 1) = 2/20, doubled.
    expect(mannWhitneyP([1, 2, 4], [3, 5, 6])).toBeCloseTo(4 / 20, 12);
  });

  it("does not call 3 vs 3 separated samples significant", () => {
    // The normal approximation says p ≈ 0.0495 here; the exact test says 0.1.
    expect(mannWhitneyP([1, 2, 3], [4, 5, 6])).toBeGreaterThan(0.05);
  });

  it("is 1 for interleaved samples and symmetric in its arguments", () => {
    expect(mannWhitneyP([1, 4], [2, 3])).toBe(1);
    const a = [120, 131, 118, 140, 125, 133, 129, 122];
    const b = [110, 115, 108, 121, 112, 119, 117, 109];
    expect(mannWhitneyP(a, b)).toBe(mannWhitneyP(b, a));
  });

  it("falls back to the tie-corrected normal approximation on ties", () => {
    expect(mannWhitneyP([5, 5, 5], [5, 5, 5])).toBe(1);
    // U = 0, six pairs of ties: σ² = 36/12 · (13 − 36/132), z = (18 − 0.5)/σ ≈ 2.8321,
    // p = erfc(z/√2) ≈ 0.0046242 (math.erfc, independently).
    expect(mannWhitneyP([1, 1, 2, 2, 3, 3], [4, 4, 5, 5, 6, 6])).toBeCloseTo(0.0046242, 6);
  });

  it("refuses an empty sample", () => {
    expect(() => mannWhitneyP([], [1])).toThrow();
  });
});
