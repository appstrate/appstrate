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
 * Tier breakpoints are powers of 1024 (binary). Precision rule
 * (matches CLI prior art the audit consolidated): values ≥ 10 in their
 * tier are rounded to an integer (e.g. `12 KB`); values < 10 carry one
 * decimal (e.g. `2.0 KB`, `5.2 MB`).
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return formatTier(kb, "KB");
  const mb = kb / 1024;
  if (mb < 1024) return formatTier(mb, "MB");
  const gb = mb / 1024;
  return formatTier(gb, "GB");
}

function formatTier(value: number, unit: string): string {
  return value >= 10 ? `${Math.round(value)} ${unit}` : `${value.toFixed(1)} ${unit}`;
}
