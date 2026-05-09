// SPDX-License-Identifier: Apache-2.0

/**
 * Human-readable formatters used across the platform's CLI, web UI,
 * runtime prompt builder, and the `@appstrate/ui` schema-form widgets.
 *
 * These helpers exist to retire four near-identical inline copies of
 * `formatBytes` that drifted on edge cases (negative input, GB tier,
 * fractional precision). Centralizing them gives one tested
 * implementation and one place to evolve.
 */

/**
 * Format a byte count as a compact human string (B / KB / MB / GB).
 *
 * Defensive against `NaN`, `Infinity`, and negative values — those fall
 * back to `"<n> B"` so callers never see a misleading positive
 * megabyte/gigabyte figure for malformed input.
 *
 * Tier breakpoints are powers of 1024 (binary). Precision: 1 decimal for
 * KB, 2 decimals for MB and GB, matching the dominant prior art in the
 * repo so visual-regression risk is minimal.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
