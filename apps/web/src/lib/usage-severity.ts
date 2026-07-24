// SPDX-License-Identifier: Apache-2.0

/**
 * Single source of truth for usage-gauge severity thresholds (percent) and the
 * Tailwind bar color they map to. Shared by every credit/storage gauge in the
 * SPA (sidebar, billing page, org-settings storage) so "near limit" means the
 * same thing everywhere.
 */

/** At/above this percent the gauge is a warning (yellow). */
export const USAGE_WARN = 70;
/** At/above this percent the gauge is critical (destructive/red). */
export const USAGE_CRITICAL = 90;

export function getUsageBarColor(usagePercent: number): string {
  if (usagePercent >= USAGE_CRITICAL) return "bg-destructive";
  if (usagePercent >= USAGE_WARN) return "bg-yellow-500";
  return "bg-primary";
}
