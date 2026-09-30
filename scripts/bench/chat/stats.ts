// SPDX-License-Identifier: Apache-2.0

/** Descriptive statistics and the significance test the chat bench reports with. */

export interface Summary {
  n: number;
  median: number;
  p90: number;
  mean: number;
  min: number;
  max: number;
}

/** Linear interpolation between closest ranks (the R-7 / spreadsheet definition). */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) throw new Error("quantile of an empty sample");
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Summary of the finite numbers in `values`; a turn that never produced a metric is `null`. */
export function summarize(values: readonly (number | null | undefined)[]): Summary | null {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (xs.length === 0) return null;
  const sorted = xs.toSorted((a, b) => a - b);
  return {
    n: xs.length,
    median: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
    min: sorted[0]!,
    max: sorted.at(-1)!,
  };
}

/**
 * Up to this many (a, b) pairs the p-value is exact. A bench compares ~8–40
 * turns per side, where the normal approximation is anti-conservative: 3 vs 3
 * fully separated samples read p ≈ 0.05 against an exact 0.1.
 */
const EXACT_MAX_PAIRS = 2500;

/**
 * Two-sided Mann-Whitney U p-value for "a and b come from the same distribution".
 * Exact when the samples are small and tie-free; otherwise the normal
 * approximation with tie-corrected variance and continuity correction.
 */
export function mannWhitneyP(a: readonly number[], b: readonly number[]): number {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 === 0 || n2 === 0) throw new Error("Mann-Whitney needs two non-empty samples");
  const all = [...a.map((v) => ({ v, inA: true })), ...b.map((v) => ({ v, inA: false }))].sort(
    (x, y) => x.v - y.v,
  );
  let rankSumA = 0;
  let tieTerm = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.v === all[i]!.v) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (all[k]!.inA) rankSumA += rank;
    const t = j - i + 1;
    tieTerm += t ** 3 - t;
    i = j + 1;
  }
  const u = rankSumA - (n1 * (n1 + 1)) / 2;
  const pairs = n1 * n2;
  if (tieTerm === 0 && pairs <= EXACT_MAX_PAIRS) {
    const counts = uDistribution(n1, n2);
    const tail = Math.min(u, pairs - u);
    let below = 0;
    for (let k = 0; k <= tail; k++) below += counts[k]!;
    const total = counts.reduce((s, c) => s + c, 0);
    return Math.min(1, (2 * below) / total);
  }
  const n = n1 + n2;
  const variance = (pairs / 12) * (n + 1 - tieTerm / (n * (n - 1)));
  if (variance <= 0) return 1;
  const z = Math.max(0, Math.abs(u - pairs / 2) - 0.5) / Math.sqrt(variance);
  return erfc(z / Math.SQRT2);
}

/**
 * How many orderings of m + n distinct values give each U (number of (a, b)
 * pairs with a > b). The largest value either belongs to a and beats all n of
 * b, or belongs to b and beats nothing: f(m, n)[u] = f(m-1, n)[u-n] + f(m, n-1)[u].
 */
function uDistribution(m: number, n: number): number[] {
  let prev: number[][] = Array.from({ length: n + 1 }, () => [1]);
  for (let i = 1; i <= m; i++) {
    const cur: number[][] = [[1]];
    for (let j = 1; j <= n; j++) {
      const row = new Array<number>(i * j + 1).fill(0);
      cur[j - 1]!.forEach((c, u) => (row[u]! += c));
      prev[j]!.forEach((c, u) => (row[u + j]! += c));
      cur.push(row);
    }
    prev = cur;
  }
  return prev[n]!;
}

/** Complementary error function, Abramowitz-Stegun 7.1.26 (|error| < 1.5e-7), for x ≥ 0. */
function erfc(x: number): number {
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return poly * Math.exp(-x * x);
}

export const fmt = (v: number | null | undefined): string =>
  v === undefined || v === null ? "—" : `${Math.round(v)}`;
